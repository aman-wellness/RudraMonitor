// POST /functions/v1/invite-member
// Headers: Authorization: Bearer <user JWT>
// Body: { email, role: 'admin' | 'viewer', full_name? }
//
// Behaviour:
//   1. Verify the caller's JWT, look up which org they own.
//   2. Insert a pending org_members row (email, role, full_name, user_id=null).
//   3. Send a Supabase magic-link invite to the email.
// When the invitee confirms their email, a trigger fills in user_id automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ROLES = new Set(["admin", "viewer"]);

type Body = { email?: string; role?: string; full_name?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  // Resolve caller via the anon-keyed client so the JWT is verified server-side.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "invalid token" }, 401);
  const callerId = userData.user.id;

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const email = (body.email ?? "").trim().toLowerCase();
  const role = (body.role ?? "").trim();
  const fullName = (body.full_name ?? "").trim() || null;
  if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);
  if (!ALLOWED_ROLES.has(role)) return json({ error: "role must be admin or viewer" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Find the caller's org (where they are owner). We restrict invites to the owner for now;
  // promote to "owner or admin" once the role-based permission story matures.
  const { data: orgs, error: orgErr } = await admin
    .from("organizations")
    .select("id")
    .eq("owner_user_id", callerId)
    .limit(1);
  if (orgErr) return json({ error: orgErr.message }, 500);
  if (!orgs || orgs.length === 0) return json({ error: "only the org owner can invite" }, 403);
  const orgId = orgs[0].id as string;

  // Insert/update the pending row first so the trigger has somewhere to link the user_id later.
  const { error: upsertErr } = await admin
    .from("org_members")
    .upsert(
      { org_id: orgId, email, role, full_name: fullName, user_id: null },
      { onConflict: "org_id,email" },
    );
  if (upsertErr) return json({ error: `pending row: ${upsertErr.message}` }, 500);

  // Send the invite. If the user already exists this is a no-op (auth API throws), so we
  // still return success because the org_members row is created.
  try {
    await admin.auth.admin.inviteUserByEmail(email, {
      data: full_name_meta(fullName),
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    // "User already registered" is fine — they just need to log in; trigger links them.
    if (!msg.toLowerCase().includes("already")) {
      return json({ error: `invite send: ${msg}` }, 500);
    }
  }

  return json({ ok: true, org_id: orgId });
});

function full_name_meta(fullName: string | null) {
  return fullName ? { full_name: fullName } : undefined;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
