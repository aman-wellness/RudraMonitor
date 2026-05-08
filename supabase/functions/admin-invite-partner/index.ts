// POST /functions/v1/admin-invite-partner
// Headers: Authorization: Bearer <super-admin user JWT>
// Body: { partner_id: string, email: string, full_name?: string }
//
// Behaviour:
//   1. Verify caller is super_admin via app_users.
//   2. Upsert pending partner_members row keyed by (partner_id, email) so the
//      link trigger ties up user_id when invitee confirms.
//   3. Send a Supabase magic-link invite email.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

type Body = { partner_id?: string; email?: string; full_name?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "invalid token" }, 401);
  const callerId = userData.user.id;

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
  const partnerId = (body.partner_id ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const fullName = (body.full_name ?? "").trim() || null;
  if (!partnerId) return json({ error: "partner_id required" }, 400);
  if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);

  // Upsert pending partner_members row so the trigger can link user_id later.
  const { error: upsertErr } = await admin
    .from("partner_members")
    .upsert(
      { partner_id: partnerId, email, role: "owner", full_name: fullName, user_id: null },
      { onConflict: "partner_id,email" },
    );
  if (upsertErr) return json({ error: `pending row: ${upsertErr.message}` }, 500);

  try {
    await admin.auth.admin.inviteUserByEmail(email, {
      data: fullName ? { full_name: fullName } : undefined,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!msg.toLowerCase().includes("already")) {
      return json({ error: `invite failed: ${msg}` }, 500);
    }
  }

  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
