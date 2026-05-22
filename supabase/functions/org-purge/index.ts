// POST /functions/v1/org-purge
// Body: { action: 'screenshots' | 'videos' | 'reset_agents' }
// Auth: caller must be an owner/admin member of the organisation (verified via
// the user's JWT). The dashboard's "Danger Zone" admin actions route here.
//
// Actions:
//   screenshots   — delete every activity_logs row with activity_type='screenshot'
//                   for this org's agents, plus the files under
//                   <bucket>/<org_id>/ in the `screenshots` storage bucket.
//   videos        — same for activity_type='video' + `videos` bucket.
//   reset_agents  — rotate enroll_token for every agent in the org and mark
//                   them offline. Existing installed agents will start getting
//                   401s on ingest and must be re-enrolled with a fresh key
//                   (license_key in the dashboard already routes them to the
//                   correct org). Useful when an organisation has stuck/lost
//                   enrolments and the admin wants a clean slate.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Action = "screenshots" | "videos" | "reset_agents";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // 1. Caller identity via the user's JWT (NOT the anon bearer the dashboard
  //    sends as the apikey). Validate the token by asking GoTrue who it
  //    belongs to — passing the JWT to admin.auth.getUser() does the
  //    verification server-side and returns the user record. The earlier
  //    "stuff the JWT into createClient as the api key" approach didn't
  //    actually validate anything and immediately broke with "invalid user
  //    session" because the JWT can't authenticate against the api endpoints
  //    as if it were an api key.
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user JWT" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userRes, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userRes?.user) {
    return json({ error: `invalid user session: ${userErr?.message ?? "no user"}` }, 401);
  }
  const userId = userRes.user.id;

  let body: { action?: Action; org_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const action = body.action;
  const orgId = (body.org_id ?? "").trim();
  if (!action || !["screenshots", "videos", "reset_agents"].includes(action)) {
    return json({ error: "invalid action" }, 400);
  }
  if (!orgId) return json({ error: "org_id required" }, 400);

  // 2. Require the caller to be an owner/admin member of the org.
  const { data: member } = await admin
    .from("org_members")
    .select("role")
    .eq("user_id", userId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!member || !["owner", "admin"].includes(String(member.role))) {
    return json({ error: "forbidden — owner or admin role required" }, 403);
  }

  // 3. Look up every agent in the org so we can scope the cleanup correctly.
  const { data: agents, error: agentsErr } = await admin
    .from("agents")
    .select("id")
    .eq("org_id", orgId);
  if (agentsErr) return json({ error: agentsErr.message }, 500);
  const agentIds = (agents ?? []).map((a) => String(a.id));

  if (action === "reset_agents") {
    const { error: updErr } = await admin
      .from("agents")
      .update({
        enroll_token: undefined,        // null means: trigger default will regenerate; see below
        status: "offline",
        last_active: null,
      })
      .eq("org_id", orgId);
    if (updErr) return json({ error: `agents update: ${updErr.message}` }, 500);
    // The agents schema sets enroll_token's default to encode(gen_random_bytes(16),'hex')
    // but `update({...: undefined})` is a no-op in postgrest. Force a fresh token
    // per agent via a SET expression call instead.
    await admin.rpc("regenerate_agent_enroll_tokens", { p_org_id: orgId }).catch(async () => {
      // Fallback if the RPC isn't deployed yet — loop and set per agent.
      for (const id of agentIds) {
        const fresh = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        await admin.from("agents").update({ enroll_token: fresh }).eq("id", id);
      }
    });
    return json({ ok: true, action, agents_reset: agentIds.length });
  }

  // For screenshot / video actions we delete:
  //   a) the activity_logs rows of that type
  //   b) the storage objects under <org_id>/ in the matching bucket
  const isScreenshot = action === "screenshots";
  const activityType = isScreenshot ? "screenshot" : "video";
  const bucket = isScreenshot ? "screenshots" : "videos";

  let rowsDeleted = 0;
  if (agentIds.length > 0) {
    const { error: delErr, count } = await admin
      .from("activity_logs")
      .delete({ count: "exact" })
      .eq("activity_type", activityType)
      .in("agent_id", agentIds);
    if (delErr) return json({ error: `activity_logs delete: ${delErr.message}` }, 500);
    rowsDeleted = count ?? 0;
  }

  // Storage cleanup — list every object under <org_id>/ recursively and remove.
  // Supabase Storage's `list` doesn't recurse, so we walk one level per agent.
  let filesDeleted = 0;
  for (const aid of agentIds) {
    const prefix = `${orgId}/${aid}`;
    let offset = 0;
    while (true) {
      const { data: objs, error: listErr } = await admin.storage
        .from(bucket)
        .list(prefix, { limit: 100, offset });
      if (listErr) break;
      if (!objs || objs.length === 0) break;
      const paths = objs.map((o) => `${prefix}/${o.name}`);
      const { error: rmErr } = await admin.storage.from(bucket).remove(paths);
      if (!rmErr) filesDeleted += paths.length;
      if (objs.length < 100) break;
      offset += objs.length;
    }
  }

  return json({ ok: true, action, rows_deleted: rowsDeleted, files_deleted: filesDeleted });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
