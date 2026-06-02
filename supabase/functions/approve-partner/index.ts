// POST /functions/v1/approve-partner
// Headers: Authorization: Bearer <super-admin JWT>
// Body: { partner_id: string }
//
// Behaviour:
//   1. Verify caller is super_admin.
//   2. Mark partner status='active', record approver/timestamp.
//   3. Send magic-link invite to partner.contact_email.
//   4. Insert partner_members row (admin, user_id=null until they sign in).
//   5. Trigger on auth.users will create app_users row as 'customer' by default;
//      we then promote it to 'partner' with partner_id once we know the user_id.
//      For now (pre-signin) we wire app_users on first login via a separate hook.
//      As an interim: store the email in partner_members so we can link on first signin.
//   6. Audit log entry.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegration } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
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

  // Verify caller is super_admin
  const { data: appUser, error: appUserErr } = await admin
    .from("app_users").select("app_role").eq("user_id", callerId).maybeSingle();
  if (appUserErr) return json({ error: appUserErr.message }, 500);
  if (!appUser || appUser.app_role !== "super_admin") {
    return json({ error: "super_admin only" }, 403);
  }

  let body: { partner_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const partnerId = body.partner_id;
  if (!partnerId) return json({ error: "partner_id required" }, 400);

  const { data: partner, error: pErr } = await admin
    .from("partners").select("*").eq("id", partnerId).maybeSingle();
  if (pErr) return json({ error: pErr.message }, 500);
  if (!partner) return json({ error: "partner not found" }, 404);
  if (partner.status === "active") return json({ error: "already active" }, 409);

  // Mark active
  const { error: upErr } = await admin
    .from("partners")
    .update({
      status: "active",
      approved_by: callerId,
      approved_at: new Date().toISOString(),
      rejection_reason: null,
    })
    .eq("id", partnerId);
  if (upErr) return json({ error: upErr.message }, 500);

  const email = (partner.contact_email as string).toLowerCase();

  // Send magic-link invite. The auth.users INSERT trigger (in 0013) auto-promotes
  // app_users → 'partner' if the email matches an active partner.
  try {
    await admin.auth.admin.inviteUserByEmail(email, {
      data: { partner_id: partnerId, partner_name: partner.name },
      redirectTo: `${(await getIntegration("APP_URL")) || "https://ems.wellnessextract.com"}/post-login`,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!msg.toLowerCase().includes("already")) {
      return json({ error: `invite: ${msg}`, partial: true }, 500);
    }
  }

  // If the auth user already existed, promote them now (trigger only fires on insert)
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const u = existing?.users.find((x) => x.email?.toLowerCase() === email);
  if (u) {
    await admin.from("app_users").upsert(
      { user_id: u.id, app_role: "partner", partner_id: partnerId },
      { onConflict: "user_id" },
    );
    await admin.from("partner_members").upsert(
      { partner_id: partnerId, user_id: u.id, role: "admin", full_name: partner.name, email },
      { onConflict: "partner_id,user_id" },
    );
  }

  // Audit
  await admin.from("audit_log").insert({
    actor_user: callerId,
    actor_role: "super_admin",
    action: "partner.approve",
    target_type: "partner",
    target_id: partnerId,
    metadata: { email, name: partner.name },
  });

  return json({ ok: true, partner_id: partnerId });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

