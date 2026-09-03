// POST /functions/v1/agent-inventory-post
// Body: { hardware, software, battery, system_events, summary }
// Auth: X-Agent-Token (enroll_token) — same pattern as agent-tool-result.
//
// Inserts a new row into public.agent_inventory. The 30-row-per-agent trim
// runs as a nightly pg_cron (see migration 0153); one bloated agent can
// never balloon the table because the trim caps history hard.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const enrollToken = (req.headers.get("x-agent-token") ?? "").trim();
  if (!enrollToken) return json({ error: "missing X-Agent-Token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve the agent (and its org) from the enroll token.
  const { data: agent, error: agentErr } = await admin
    .from("agents")
    .select("id, org_id")
    .eq("enroll_token", enrollToken)
    .maybeSingle();
  if (agentErr) return json({ error: `agent lookup: ${agentErr.message}` }, 500);
  if (!agent) return json({ error: "unknown enroll_token" }, 401);

  let body: {
    hardware?: unknown;
    software?: unknown;
    battery?: unknown;
    system_events?: unknown;
    summary?: unknown;
  };
  try { body = await req.json(); }
  catch { return json({ error: "invalid json body" }, 400); }

  const { error: insertErr } = await admin.from("agent_inventory").insert({
    org_id: agent.org_id,
    agent_id: agent.id,
    hardware: body.hardware ?? {},
    software: body.software ?? [],
    battery: body.battery ?? null,
    system_events: body.system_events ?? [],
    summary: body.summary ?? {},
  });
  if (insertErr) return json({ error: `insert: ${insertErr.message}` }, 500);

  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
