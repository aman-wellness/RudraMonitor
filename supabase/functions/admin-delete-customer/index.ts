// POST /functions/v1/admin-delete-customer
// Body: { org_id: uuid }
//
// Super-admin only. Hard-deletes a customer org AND the auth.users rows
// belonging to that org's members so the same email can't sign back in.
// Previous behavior (client-side `delete from organizations`) left auth
// users orphaned — the deleted owner could still log in and even
// re-trigger trial signup. This function:
//
//   1. Collects every user_id linked to the org (org_members + owner).
//   2. Deletes the organizations row (cascades to licenses, agents,
//      org_members, screenshots, alerts, etc. via FK ON DELETE CASCADE).
//   3. For each collected user_id, if they don't belong to any other
//      org (not in org_members anywhere and not owner of any other org),
//      delete the auth.users row. Users who are still in another org
//      are kept so we don't break a shared admin's access.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) return json({ error: "unauthenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userRes } = await admin.auth.getUser(bearer);
  const actor = userRes?.user?.id;
  if (!actor) return json({ error: "unauthenticated" }, 401);

  // is_super_admin() reads auth.uid() — but the service-role client we use
  // here has no session, so auth.uid() is NULL and the RPC always returns
  // false. Check the role directly against the actor's user_id instead.
  const { data: roleRow } = await admin
    .from("app_users").select("app_role").eq("user_id", actor).maybeSingle();
  if (roleRow?.app_role !== "super_admin") return json({ error: "super admin required" }, 403);

  let body: { org_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.org_id) return json({ error: "org_id required" }, 400);
  const orgId = body.org_id;

  const { data: org } = await admin
    .from("organizations").select("id, name, owner_user_id").eq("id", orgId).maybeSingle();
  if (!org) return json({ error: "Organization not found" }, 404);

  // Collect all user ids tied to this org (members + owner).
  const userIds = new Set<string>();
  if (org.owner_user_id) userIds.add(org.owner_user_id);
  const { data: members } = await admin
    .from("org_members").select("user_id").eq("org_id", orgId);
  for (const m of (members ?? [])) {
    if (m.user_id) userIds.add(m.user_id);
  }

  // invoices.organization_id has ON DELETE RESTRICT, so drop those first.
  await admin.from("invoices").delete().eq("organization_id", orgId);

  // Delete the org (other FK cascades clean up licenses/agents/etc.).
  const { error: delOrgErr } = await admin
    .from("organizations").delete().eq("id", orgId);
  if (delOrgErr) {
    return json({ error: `Could not delete org: ${delOrgErr.message}` }, 500);
  }

  // Now decide which auth users to nuke: only those with zero remaining
  // org memberships AND not the owner of any other org.
  const deletedAuth: string[] = [];
  const kept: string[] = [];
  for (const uid of userIds) {
    const { count: stillMember } = await admin
      .from("org_members").select("*", { count: "exact", head: true }).eq("user_id", uid);
    const { count: ownsOther } = await admin
      .from("organizations").select("*", { count: "exact", head: true }).eq("owner_user_id", uid);
    if ((stillMember ?? 0) > 0 || (ownsOther ?? 0) > 0) {
      kept.push(uid);
      continue;
    }
    // Also skip super-admins so we never lock ourselves out.
    const { data: superRow } = await admin
      .from("app_users").select("user_id").eq("user_id", uid).eq("app_role", "super_admin").maybeSingle();
    if (superRow) { kept.push(uid); continue; }

    const { error: authDelErr } = await admin.auth.admin.deleteUser(uid);
    if (authDelErr) {
      console.error(`auth delete failed for ${uid}:`, authDelErr.message);
      kept.push(uid);
    } else {
      deletedAuth.push(uid);
    }
  }

  await admin.from("audit_log").insert({
    actor_user: actor, actor_role: "super_admin",
    action: "customer.delete", target_type: "organization", target_id: orgId,
    metadata: { org_name: org.name, deleted_auth_users: deletedAuth, kept_auth_users: kept },
  });

  return json({ ok: true, deleted_auth_users: deletedAuth.length, kept_auth_users: kept.length });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
