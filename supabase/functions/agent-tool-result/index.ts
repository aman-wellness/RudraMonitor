// POST /functions/v1/agent-tool-result
//
// Called by the running agent AFTER it finishes executing (or errors out
// on) an endpoint-tool run. Uploads the result artifact (if any) to the
// `tool-run-reports` storage bucket and UPDATEs the corresponding
// `tool_runs` row with exit_code / duration / stdout tail / state.
//
// Auth: agent's enroll_token (X-Agent-Token or Authorization: Bearer),
// same pattern as agent-settings / agent-signature-fetch. The token
// authenticates the AGENT, not a user — we verify it maps to an agent
// row that owns the `run_id` we're updating.
//
// Body: {
//   run_id: uuid,
//   exit_code: integer,
//   duration_ms: integer,
//   state: 'succeeded' | 'failed' | 'timed_out',
//   stdout_tail: string,          // last ~8KB
//   report_b64?: string,          // base64-encoded artifact bytes
//   artifact_filename?: string    // e.g. "InstalledDrivers.csv"
// }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Agent runs on customer endpoints; CORS ACAO=* matches other agent-*
// endpoints (agent-settings, agent-signature-fetch).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-agent-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
} as const;

interface Body {
  run_id: string;
  exit_code: number;
  duration_ms: number;
  state: "succeeded" | "failed" | "timed_out";
  stdout_tail: string;
  report_b64?: string;
  artifact_filename?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";
  const token = xAgent || bearer;
  if (!token) return json({ error: "missing agent token" }, 401);

  let body: Body;
  try { body = await req.json() as Body; }
  catch { return json({ error: "invalid json" }, 400); }

  if (!body.run_id) return json({ error: "run_id required" }, 400);
  // v0.6.25+ — allow agent to POST an early 'running' update the moment it
  // picks up the tool.run event, before the script has finished. Without
  // this the dashboard row sits at 'pending' for up to 30 min during a
  // Windows Optimizer run and admins think it never dispatched.
  const VALID = new Set(["running", "succeeded", "failed", "timed_out"]);
  if (!VALID.has(body.state)) {
    return json({ error: "state must be running/succeeded/failed/timed_out" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve agent → id from the enroll_token. The tool_runs row we're
  // updating must belong to this agent.
  const { data: agent } = await admin
    .from("agents")
    .select("id, org_id")
    .eq("enroll_token", token)
    .maybeSingle();
  if (!agent) return json({ error: "invalid agent token" }, 401);

  const { data: run } = await admin
    .from("tool_runs")
    .select("id, agent_id, state, tool_kind")
    .eq("id", body.run_id)
    .maybeSingle();
  if (!run) return json({ error: "run not found" }, 404);
  if (run.agent_id !== agent.id) {
    return json({ error: "run does not belong to this agent" }, 403);
  }

  // Upload artifact (if provided). Bucket is private; the dashboard mints
  // signed URLs on demand from the returned report_path.
  let reportPath: string | null = null;
  if (body.report_b64 && body.artifact_filename) {
    try {
      const binary = Uint8Array.from(atob(body.report_b64), (c) => c.charCodeAt(0));
      // Sanitise filename so the agent can't inject path traversal.
      const safeName = body.artifact_filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
      const key = `${agent.id}/${body.run_id}-${safeName}`;
      const { error: upErr } = await admin.storage
        .from("tool-run-reports")
        .upload(key, binary, {
          contentType: safeName.endsWith(".csv") ? "text/csv"
                        : safeName.endsWith(".txt") ? "text/plain"
                        : "application/octet-stream",
          upsert: true,
        });
      if (upErr) {
        console.warn(`[agent-tool-result] artifact upload failed: ${upErr.message}`);
      } else {
        reportPath = key;
      }
    } catch (e) {
      console.warn(`[agent-tool-result] artifact decode failed: ${(e as Error).message}`);
    }
  }

  // UPDATE the row. For the early 'running' ping we only stamp state +
  // started_at — the script is still executing so exit_code / duration /
  // completed_at aren't known yet.
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { state: body.state };
  if (body.state === "running") {
    patch.started_at = now;
  } else {
    patch.exit_code    = body.exit_code;
    patch.duration_ms  = body.duration_ms;
    patch.stdout_tail  = (body.stdout_tail ?? "").slice(0, 8192);
    if (reportPath) patch.report_path = reportPath;
    patch.completed_at = now;
    // Leave started_at as-is if the agent already posted 'running'; back-
    // fill from `now` for agents that skip the early ping (pre-v0.6.25).
    patch.started_at = run.state === "running" ? undefined : now;
  }
  const { error: uErr } = await admin
    .from("tool_runs")
    .update(patch)
    .eq("id", body.run_id);
  if (uErr) return json({ error: `update failed: ${uErr.message}` }, 500);

  return json({ ok: true, report_path: reportPath });
});
