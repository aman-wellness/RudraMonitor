// POST /functions/v1/ingest
// Headers:
//   Authorization: Bearer <enroll_token>   (also acceptable as X-Agent-Token)
// Body: { kind: "system_metrics" | "activity_logs" | "alerts", payload: any[] }
//
// The function:
//   1. Validates the enroll_token against agents.enroll_token (service role).
//   2. Inserts each payload row into the matching table with agent_id set.
//   3. Touches agents.last_active and status='online'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type IngestBody = {
  kind?: "system_metrics" | "activity_logs" | "alerts";
  payload?: Record<string, unknown>[];
};

const ALLOWED_TABLES: Record<string, string> = {
  system_metrics: "system_metrics",
  activity_logs: "activity_logs",
  alerts: "alerts",
};

// Fields we accept per kind. Everything else is dropped — defensive against malformed agents.
const ALLOWED_FIELDS: Record<string, Set<string>> = {
  system_metrics: new Set([
    "cpu_usage", "ram_usage", "disk_usage", "disk_activity", "battery_level", "network_speed", "recorded_at",
  ]),
  // SECURITY REVIEW M3: screenshot_url / video_url are deliberately NOT
  // accepted here. The agent only ever sets them through upload-screenshot /
  // upload-video (which write the storage object first, then insert the row),
  // so allowing them on the generic ingest path served no purpose and let a
  // token holder point a row at another org's storage key. Screenshot/video
  // rows continue to work — they just don't come through ingest.
  activity_logs: new Set([
    "activity_type", "application_name", "url", "page_title", "duration", "created_at",
  ]),
  alerts: new Set([
    "alert_type", "message", "ai_resolved", "resolution", "created_at",
  ]),
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Token can come either as Bearer or X-Agent-Token. Bearer is cleaner; X-Agent-Token is a fallback
  // because the Supabase gateway sometimes rewrites Authorization with the anon key.
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";
  const token = xAgent || bearer;
  if (!token) return json({ error: "missing agent token" }, 401);

  let body: IngestBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const kind = body.kind ?? "";
  const payload = Array.isArray(body.payload) ? body.payload : null;
  if (!ALLOWED_TABLES[kind]) return json({ error: "invalid kind" }, 400);
  if (!payload || payload.length === 0) return json({ error: "empty payload" }, 400);
  if (payload.length > 200) return json({ error: "payload too large" }, 413);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Validate token → resolve agent_id.
  const { data: agent, error: agentErr } = await admin
    .from("agents")
    .select("id, org_id")
    .eq("enroll_token", token)
    .maybeSingle();
  if (agentErr) return json({ error: agentErr.message }, 500);
  if (!agent) return json({ error: "invalid token" }, 401);

  // Subscription gate — once trial expires (or org suspended/cancelled), the
  // agent is silently rejected with 402. Authoritative check via
  // is_subscription_active() so trial vs paid vs expired all flow through one
  // place. Returns 402 (not 401) so the agent can distinguish "stopped paying"
  // from "bad token" and surface a renewal hint to the user.
  const { data: active } = await admin.rpc("is_subscription_active", { p_org_id: agent.org_id });
  if (!active) {
    return json({ error: "subscription_inactive", hint: "trial_expired_or_unpaid" }, 402);
  }

  // Seat enforcement (migration 0078). When the org's seat_count is lower
  // than the number of enrolled agents, the newest ones (beyond cap) are
  // "locked": ingest from them is silently refused so their data stops
  // populating the dashboard. Upgrading the seat_count re-includes them.
  const { data: seatOk } = await admin.rpc("agent_seat_ok", { p_agent_id: agent.id });
  if (!seatOk) {
    return json({ error: "seat_limit_exceeded", hint: "agent_over_license_cap" }, 402);
  }

  const table = ALLOWED_TABLES[kind];
  const fields = ALLOWED_FIELDS[kind];
  const rows = payload.map((p) => {
    const cleaned: Record<string, unknown> = { agent_id: agent.id };
    for (const [k, v] of Object.entries(p)) {
      if (fields.has(k)) cleaned[k] = v;
    }
    return cleaned;
  });

  const { error: insertErr } = await admin.from(table).insert(rows);
  if (insertErr) return json({ error: insertErr.message }, 500);

  // Update last_active heartbeat. If the agent is reporting its build version
  // along with the payload (added in agent v0.2.6+), refresh that too so the
  // dashboard reflects auto-updates without waiting for a re-enroll.
  const updates: Record<string, unknown> = {
    last_active: new Date().toISOString(),
    status: "online",
  };
  const reportedVersion = typeof (body as { agent_version?: unknown }).agent_version === "string"
    ? ((body as { agent_version: string }).agent_version).trim()
    : "";
  if (reportedVersion) updates.agent_version = reportedVersion;
  await admin.from("agents").update(updates).eq("id", agent.id);

  return json({ ok: true, inserted: rows.length });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
