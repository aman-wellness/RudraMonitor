// POST /functions/v1/agent-update-settings
// Body: { agent_id: uuid, patch: { <agents column>: value, ... } }
// Headers: Authorization: Bearer <user JWT>
//
// Why this exists when RLS already gates writes via `agents_write` policy:
//   • Supabase JS update() returns `{ data: [], error: null }` when RLS
//     silently denies — there's no way to surface "permission denied" as
//     a user-visible error. Customers were toggling settings, seeing
//     "Saved!", reloading, and finding their changes reverted with no
//     explanation. We've burned hours diagnosing this.
//   • Stale JWTs, super-admin sessions that don't map cleanly to
//     `org_members`, and the occasional broken cookie all manifest the
//     same way through direct RLS writes.
//
// This function does the write with the service-role client, but only
// after we've explicitly verified the caller's JWT belongs to a member
// of the agent's org. Failures are returned as proper HTTP errors so
// the UI can show them.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Columns the dashboard is allowed to mutate via this endpoint. Anything
// not in this set is silently dropped from the patch — prevents a
// malicious caller from flipping enroll_token / org_id / etc.
const ALLOWED_COLUMNS = new Set<string>([
  "screenshots_enabled",
  "videos_enabled",
  "dlp_enabled",
  "active_window_enabled",
  "screenshot_interval_secs",
  "idle_threshold_secs",
  "video_interval_secs",
  "removable_disks_blocked",
  "wallpaper_enforced",
  "tracking_schedule_override",
  "tracking_schedule_json",
  "agent_name",
  "department",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing authorization bearer token" }, 401);

  let body: { agent_id?: string; patch?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  const agentId = (body.agent_id ?? "").trim();
  const patch = body.patch ?? {};
  if (!agentId) return json({ error: "agent_id is required" }, 400);
  if (typeof patch !== "object" || patch === null) return json({ error: "patch must be an object" }, 400);

  // Resolve caller's identity. Using the user-scoped client (anon key + the
  // user's JWT) ensures the user actually has a valid session; the service-
  // role write below only fires once this check passes.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user?.id) {
    return json({ error: "invalid or expired session", detail: userErr?.message }, 401);
  }
  const callerUid = userData.user.id;

  // Service-role client for the actual write + org membership lookup.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Look up the agent's org_id (without RLS) and the caller's org memberships.
  const [agentRow, memberRows] = await Promise.all([
    admin.from("agents").select("org_id").eq("id", agentId).maybeSingle(),
    admin.from("org_members").select("org_id, role").eq("user_id", callerUid),
  ]);
  if (agentRow.error) return json({ error: "agent lookup failed", detail: agentRow.error.message }, 500);
  if (!agentRow.data) return json({ error: "agent not found", agent_id: agentId }, 404);
  if (memberRows.error) return json({ error: "membership lookup failed", detail: memberRows.error.message }, 500);

  const memberships = (memberRows.data ?? []) as { org_id: string; role: string }[];
  const matchedMembership = memberships.find((m) => m.org_id === agentRow.data!.org_id);
  if (!matchedMembership) {
    // Super-admin override — service-role bypass for users in `super_admins`
    // table (existing pattern in the dashboard). If the caller is a super
    // admin we still allow the write across orgs.
    const { data: superRow } = await admin
      .from("super_admins")
      .select("user_id")
      .eq("user_id", callerUid)
      .maybeSingle();
    if (!superRow) {
      return json(
        {
          error: "permission denied",
          detail: "Caller is not a member of the agent's organization.",
          caller_uid: callerUid,
          agent_org_id: agentRow.data.org_id,
          caller_orgs: memberships.map((m) => m.org_id),
        },
        403,
      );
    }
  } else if (matchedMembership.role !== "owner" && matchedMembership.role !== "admin") {
    return json(
      {
        error: "permission denied",
        detail: `Role '${matchedMembership.role}' cannot update agent settings (owner/admin only).`,
      },
      403,
    );
  }

  // Filter the patch to allowed columns only.
  const cleanPatch: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (ALLOWED_COLUMNS.has(k)) cleanPatch[k] = v;
    else ignored.push(k);
  }
  if (Object.keys(cleanPatch).length === 0) {
    return json({ error: "no allowed columns in patch", ignored }, 400);
  }

  const { data: updated, error: updErr } = await admin
    .from("agents")
    .update(cleanPatch)
    .eq("id", agentId)
    .select("id, removable_disks_blocked, wallpaper_enforced, screenshots_enabled, videos_enabled, dlp_enabled, screenshot_interval_secs, video_interval_secs")
    .maybeSingle();

  if (updErr) {
    console.error("agent-update-settings: write failed", updErr);
    return json({ error: "update failed", detail: updErr.message }, 500);
  }
  if (!updated) {
    return json({ error: "update affected no rows" }, 500);
  }

  return json({ ok: true, agent: updated, ignored });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
