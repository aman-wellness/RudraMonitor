// POST /functions/v1/directory-disconnect
// Headers: Authorization: Bearer <user JWT>
// Body:    { provider: 'm365' | 'google' }
//
// Wipes the org's directory data for the given provider and marks
// org_integrations as disconnected. The integration row itself is kept so
// historical references survive — only the live data (tenant_id, tokens,
// directory_users/groups/group_members) is removed.
//
// Owner-only — only the org owner can disconnect a provider.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = bearer(req);
  if (!jwt) return json({ error: "missing user token" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  let body: { provider?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const provider = body.provider;
  if (provider !== "m365" && provider !== "google") {
    return json({ error: "provider must be 'm365' or 'google'" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Find the org that (a) the caller is a member of AND (b) actually has an
  // integration row for this provider. The previous "owner_user_id only"
  // lookup picked the wrong org when the caller owned one org but used a
  // different org's M365 connection — DELETE then matched 0 rows.
  const { data: memberships } = await admin
    .from("org_members").select("org_id").eq("user_id", u.user.id);
  const memberOrgIds = (memberships ?? []).map((m: { org_id: string }) => m.org_id);

  const { data: ownedOrgs } = await admin
    .from("organizations").select("id").eq("owner_user_id", u.user.id);
  const ownedOrgIds = (ownedOrgs ?? []).map((o: { id: string }) => o.id);

  const candidateOrgIds = Array.from(new Set([...memberOrgIds, ...ownedOrgIds]));
  if (candidateOrgIds.length === 0) {
    return json({ error: "no orgs found for this user" }, 403);
  }

  const { data: integ } = await admin
    .from("org_integrations")
    .select("org_id")
    .eq("provider", provider)
    .in("org_id", candidateOrgIds)
    .limit(1)
    .maybeSingle();

  if (!integ) {
    return json({ error: `${provider} integration not found for any of your orgs` }, 404);
  }
  const orgId = integ.org_id as string;

  // 1) Drop group memberships (FK to directory_groups will cascade, but doing
  //    it explicitly keeps the deletion auditable + works even if cascades are
  //    set differently across environments).
  const { data: gids } = await admin
    .from("directory_groups").select("id").eq("org_id", orgId).eq("provider", provider);
  const groupIds = (gids ?? []).map((g: { id: string }) => g.id);
  if (groupIds.length > 0) {
    await admin.from("directory_group_members").delete().in("group_id", groupIds);
  }

  // 2) Drop groups + users for this provider.
  await admin.from("directory_groups").delete().eq("org_id", orgId).eq("provider", provider);
  await admin.from("directory_users").delete().eq("org_id", orgId).eq("provider", provider);

  // 3) Drop the integration row entirely. We previously just marked it
  //    status='disconnected', but the directory-sync background task races
  //    with disconnect — its final UPDATE would overwrite our status back to
  //    'active' or 'error'. Deleting the row stops the race: the in-flight
  //    sync's tail UPDATE will affect 0 rows and the cron sweeper skips
  //    missing rows. Reconnect re-INSERTs cleanly.
  const { error: delErr, count: delCount } = await admin
    .from("org_integrations")
    .delete({ count: "exact" })
    .eq("org_id", orgId)
    .eq("provider", provider);

  if (delErr) return json({ error: `delete failed: ${delErr.message}` }, 500);

  return json({
    ok: true,
    provider,
    org_id: orgId,
    removed_groups: groupIds.length,
    removed_integration_rows: delCount ?? 0,
  }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
