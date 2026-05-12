// POST /functions/v1/admin-invite-customer-owner
// Headers: Authorization: Bearer <super-admin user JWT>
// Body: { org_id: string, email: string, full_name?: string, role?: 'owner'|'admin' }
//
// Behaviour:
//   1. Verify caller is a super_admin via app_users.
//   2. Upsert pending org_members row (email keyed) so the link trigger ties up
//      user_id once they confirm.
//   3. Send a Supabase magic-link invite email — recipient clicks, sets a password,
//      and lands logged in.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

type Body = { org_id?: string; email?: string; full_name?: string; role?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  // 1. Verify caller via anon-keyed client so the JWT is checked server-side.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "invalid token" }, 401);
  const callerId = userData.user.id;

  // 2. Confirm super_admin role.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: appUser } = await admin
    .from("app_users")
    .select("app_role")
    .eq("user_id", callerId)
    .maybeSingle();
  if (!appUser || appUser.app_role !== "super_admin") {
    return json({ error: "forbidden: super_admin only" }, 403);
  }

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const orgId = (body.org_id ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const fullName = (body.full_name ?? "").trim() || null;
  const role = body.role === "owner" ? "owner" : "admin";
  if (!orgId) return json({ error: "org_id required" }, 400);
  if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);

  // 3. Upsert the pending org_members row. The unique index is
  //    `(org_id, lower(email)) WHERE email IS NOT NULL` — partial — so
  //    `onConflict: "org_id,email"` can't match it. Do find-then-write.
  const { data: existing } = await admin
    .from("org_members")
    .select("id")
    .eq("org_id", orgId)
    .ilike("email", email)
    .maybeSingle();
  if (existing) {
    const { error: updErr } = await admin
      .from("org_members")
      .update({ role, full_name: fullName })
      .eq("id", existing.id);
    if (updErr) return json({ error: `pending row: ${updErr.message}` }, 500);
  } else {
    const { error: insErr } = await admin
      .from("org_members")
      .insert({ org_id: orgId, email, role, full_name: fullName, user_id: null });
    if (insErr) return json({ error: `pending row: ${insErr.message}` }, 500);
  }

  // 4. Send the right email depending on whether the user already exists:
  //    - New email → invite (creates auth.users + sends magic-link)
  //    - Already registered → password recovery email (the only thing
  //      Supabase actually delivers for an existing user; pure invite is a
  //      no-op silently and admin sees no email arrive).
  const appUrl = Deno.env.get("APP_URL") ?? "http://localhost:3000";
  const { data: listed } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
  const existingUser = listed?.users?.find((u) => u.email?.toLowerCase() === email);
  let mode: "invite" | "recovery" = "invite";
  let lastErr: string | null = null;

  if (existingUser) {
    mode = "recovery";
    const { error } = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: `${appUrl}/reset-password` },
    });
    if (error) lastErr = error.message;
  } else {
    try {
      await admin.auth.admin.inviteUserByEmail(email, {
        data: { ...(fullName ? { full_name: fullName } : {}), invite_role: "customer_owner" },
        redirectTo: `${appUrl}/post-login`,
      });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.toLowerCase().includes("already")) {
        mode = "recovery";
        const { error } = await admin.auth.admin.generateLink({
          type: "recovery",
          email,
          options: { redirectTo: `${appUrl}/reset-password` },
        });
        if (error) lastErr = error.message;
      } else {
        lastErr = msg;
      }
    }
  }

  if (lastErr) return json({ error: `invite failed: ${lastErr}` }, 500);
  return json({ ok: true, mode });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
