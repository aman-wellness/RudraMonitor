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

  // 3. Upsert the pending org_members row keyed by (org_id, email).
  const { error: upsertErr } = await admin
    .from("org_members")
    .upsert(
      { org_id: orgId, email, role, full_name: fullName, user_id: null },
      { onConflict: "org_id,email" },
    );
  if (upsertErr) return json({ error: `pending row: ${upsertErr.message}` }, 500);

  // 4. Send the magic-link invite. "User already registered" is fine — the link trigger
  //    will tie their existing user_id to this org's pending row on next login.
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
