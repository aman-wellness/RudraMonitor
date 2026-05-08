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
    "cpu_usage", "ram_usage", "disk_usage", "battery_level", "network_speed", "recorded_at",
  ]),
  activity_logs: new Set([
    "activity_type", "application_name", "url", "page_title", "duration", "screenshot_url", "video_url", "created_at",
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

  // Update last_active heartbeat.
  await admin
    .from("agents")
    .update({ last_active: new Date().toISOString(), status: "online" })
    .eq("id", agent.id);

  return json({ ok: true, inserted: rows.length });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
