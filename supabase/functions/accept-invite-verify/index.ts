// POST /functions/v1/accept-invite-verify
// PUBLIC. Body: { email, otp, password }
//
// Completes an OTP-based invite. Verifies the code, sets the invitee's
// password via the auth admin API, and flips email_confirmed_at — which
// triggers `link_pending_org_member` to bind their auth user to the
// pending org_members row. Caller can then sign in with email+password.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_ATTEMPTS = 5;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { email?: string; otp?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const email = (body.email ?? "").trim().toLowerCase();
  const otp = (body.otp ?? "").trim();
  const password = body.password ?? "";
  if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);
  if (!/^\d{6}$/.test(otp)) return json({ error: "6-digit OTP required" }, 400);
  if (password.length < 8) return json({ error: "password must be at least 8 characters" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Pull the latest unused, unexpired OTP for this email.
  const { data: row } = await admin
    .from("otp_codes")
    .select("id, code_hash, attempts, expires_at")
    .ilike("target", email)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!row) return json({ error: "No active OTP — request a new invite from your admin" }, 400);
  if (row.attempts >= MAX_ATTEMPTS) {
    return json({ error: "Too many attempts. Ask your admin to resend the invite." }, 400);
  }

  const hash = await sha256Hex(otp);
  if (hash !== row.code_hash) {
    await admin.from("otp_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
    return json({ error: "Incorrect code" }, 400);
  }
  // NOTE: don't mark the OTP used yet — only after the password set succeeds.
  // If we marked it used here and the password-set step failed, the customer
  // would be stuck with a consumed code and have to request a new invite.

  // 2. Find the auth user — invite-member creates them with email_confirm=false.
  // PostgREST won't expose the `auth` schema directly on self-hosted
  // Supabase, so we delegate to a SECURITY DEFINER helper (migration 0104).
  const { data: userId, error: userErr } = await admin
    .rpc("find_auth_user_id_by_email", { p_email: email });
  if (userErr) return json({ error: `user lookup: ${userErr.message}` }, 500);
  const user = userId ? { id: userId as string } : null;
  if (!user) return json({ error: "No invite on record for this email. Ask your admin to resend." }, 404);

  // 3. Set password + confirm email in one call. The auth UPDATE fires the
  //    link_pending_org_member trigger which binds org_members.user_id.
  const { error: updErr } = await admin.auth.admin.updateUserById(user.id, {
    password,
    email_confirm: true,
  });
  if (updErr) return json({ error: `set password: ${updErr.message}` }, 500);

  // Password set succeeded — NOW mark the OTP consumed.
  await admin.from("otp_codes").update({ used_at: new Date().toISOString() }).eq("id", row.id);

  // 4. Defensive: also call the link RPC in case the trigger didn't fire.
  //    (It's idempotent.)
  try {
    await admin.rpc("link_my_pending_invites").select(); // best-effort; service role won't have auth.uid()
  } catch { /* ignore */ }

  // Manual link by email under service role (the RPC needs auth.uid()).
  await admin
    .from("org_members")
    .update({ user_id: user.id })
    .ilike("email", email)
    .is("user_id", null);

  // Make sure the app_role reflects this user as a CUSTOMER member, not a
  // partner. The handle_new_user_role trigger can mis-classify users when
  // app_users has a stale 'partner' row with NULL partner_id — that'd send
  // them to the partner portal instead of /dashboard. Force-correct here:
  // if they have an org_members row and aren't tied to an ACTIVE partner,
  // their role is 'customer'.
  const { data: appRow } = await admin
    .from("app_users")
    .select("app_role, partner_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const looksOrphanPartner = appRow?.app_role === "partner" && !appRow?.partner_id;
  if (!appRow) {
    await admin.from("app_users").insert({ user_id: user.id, app_role: "customer" });
  } else if (looksOrphanPartner) {
    await admin.from("app_users").update({ app_role: "customer", partner_id: null }).eq("user_id", user.id);
  }

  return json({ ok: true, email });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
