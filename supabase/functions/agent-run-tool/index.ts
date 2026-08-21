// POST /functions/v1/agent-run-tool
//
// Body: { agent_id: uuid, tool_kind: 'driver_updater' | 'windows_optimizer' }
// Auth: user JWT — must be owner/admin of the org that owns the agent.
//
// Flow:
//   1. Verify caller is admin of the agent's org
//   2. Reject if the agent has another run pending/running (exclusive
//      via the unique partial index in 0129 migration)
//   3. Insert `tool_runs` row with state='pending', triggered_by=caller
//   4. Broadcast on Realtime channel `agent:<agent_id>` event `tool.run`
//      with payload { tool, run_id } — same pattern the signature-push
//      edge fn uses
//   5. Return { run_id, state: 'pending' } — dashboard subscribes to
//      the `tool_runs` row for further state transitions
//
// Non-goals: this function does NOT wait for the run to complete. The
// agent POSTs back to `agent-tool-result` when done.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsFor } from "../_shared/cors.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;

type ToolKind = "driver_updater" | "windows_optimizer";

interface Body {
  agent_id: string;
  tool_kind: ToolKind;
}

const json = (body: unknown, status = 200, cors: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405, cors);

  const authHeader = req.headers.get("authorization") ?? "";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let body: Body;
  try { body = await req.json() as Body; }
  catch { return json({ error: "invalid json" }, 400, cors); }

  if (!body.agent_id || typeof body.agent_id !== "string") {
    return json({ error: "agent_id required" }, 400, cors);
  }
  if (body.tool_kind !== "driver_updater" && body.tool_kind !== "windows_optimizer") {
    return json({ error: "tool_kind must be driver_updater or windows_optimizer" }, 400, cors);
  }

  // Resolve caller identity from the JWT.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401, cors);

  // Load agent + verify caller is owner/admin of its org.
  const { data: agent, error: aErr } = await admin
    .from("agents")
    .select("id, org_id, os_type, agent_name")
    .eq("id", body.agent_id)
    .maybeSingle();
  if (aErr || !agent) return json({ error: "agent not found" }, 404, cors);

  const { data: mem } = await admin
    .from("org_members")
    .select("role")
    .eq("user_id", u.user.id)
    .eq("org_id", agent.org_id)
    .in("role", ["owner", "admin"])
    .maybeSingle();
  if (!mem) return json({ error: "must be owner/admin of this org" }, 403, cors);

  // Guard: endpoint tools are Windows-only. The dashboard button is gated
  // on os_type but we double-check server-side in case someone crafts the
  // POST manually.
  const osType = (agent.os_type ?? "").toLowerCase();
  if (!osType.includes("windows")) {
    return json({
      error: "endpoint tools are Windows-only — this agent reports " + (agent.os_type ?? "unknown"),
    }, 400, cors);
  }

  // INSERT — the unique partial index on (agent_id) where state in
  // ('pending','running') gives us atomic overlap rejection.
  const { data: inserted, error: iErr } = await admin
    .from("tool_runs")
    .insert({
      org_id:       agent.org_id,
      agent_id:     agent.id,
      tool_kind:    body.tool_kind,
      state:        "pending",
      triggered_by: u.user.id,
    })
    .select("id")
    .single();
  if (iErr) {
    if (iErr.code === "23505") {
      // Unique-constraint violation — an active run already exists.
      return json({
        error: "another tool run is already pending or running on this agent",
        error_code: "run_in_progress",
      }, 409, cors);
    }
    return json({ error: `insert failed: ${iErr.message}` }, 500, cors);
  }
  const runId = inserted!.id as string;

  // Broadcast on the agent's Realtime channel. Same pattern as
  // signatures-push: create channel, send, remove. If the send fails we
  // still return success — the row is inserted and the agent will pick
  // up the event on its next Realtime reconnect anyway (Supabase
  // Realtime doesn't buffer missed broadcasts, but the row will fall to
  // 'timed_out' on the DB side after 60s if the agent never ack'd).
  try {
    const ch = admin.channel(`agent:${agent.id}`);
    await ch.send({
      type: "broadcast",
      event: "tool.run",
      payload: { tool: body.tool_kind, run_id: runId, at: new Date().toISOString() },
    });
    await admin.removeChannel(ch);
  } catch (e) {
    console.warn(`[agent-run-tool] broadcast failed: ${(e as Error).message}`);
  }

  return json({ run_id: runId, state: "pending" }, 200, cors);
});
