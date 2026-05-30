// POST /functions/v1/remote-session-ready
// Caller: AGENT (X-Agent-Token).
// Body:   { session_id: uuid, rustdesk_id: text, rustdesk_pass?: text }
//
// The agent calls this once its `rustdesk --host-only` subprocess has
// registered with hbbs and printed { event:"ready", id:"<9-digit>" }.
// We persist the ID + (optional) one-time password to remote_sessions
// and broadcast to the dashboard so the iframe can launch.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";
  if (!xAgent) return json({ error: "missing X-Agent-Token" }, 401);

  let body: { session_id?: string; rustdesk_id?: string; rustdesk_pass?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const sessionId   = (body.session_id ?? "").trim();
  const rustdeskId  = (body.rustdesk_id ?? "").trim();
  if (!sessionId || !rustdeskId) {
    return json({ error: "session_id + rustdesk_id required" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Agent auth + ownership check.
  const { data: agent } = await admin
    .from("agents").select("id, org_id").eq("enroll_token", xAgent).maybeSingle();
  if (!agent) return json({ error: "invalid agent token" }, 401);
  const agentId = (agent as { id: string }).id;
  const orgId   = (agent as { org_id: string }).org_id;

  const { data: session } = await admin
    .from("remote_sessions")
    .select("id, agent_id, state")
    .eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "session not found" }, 404);
  if ((session as { agent_id: string }).agent_id !== agentId) {
    return json({ error: "session does not belong to this agent" }, 403);
  }
  const currentState = (session as { state: string }).state;
  if (currentState !== "approved" && currentState !== "publishing") {
    return json({ error: `session not in approvable state (current: ${currentState})` }, 409);
  }

  // Persist + flip state.
  const { error: updErr } = await admin
    .from("remote_sessions")
    .update({
      rustdesk_id: rustdeskId,
      state: "publishing",
      started_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (updErr) return json({ error: `state update: ${updErr.message}` }, 500);

  await admin.from("remote_audit_logs").insert({
    session_id: sessionId, org_id: orgId,
    actor_kind: "agent", action: "session_started",
    metadata: { rustdesk_id: rustdeskId },
  });

  // Broadcast — dashboard iframe now has the rustdesk_id it needs.
  // We forward the actual rustdesk_pass too: the dashboard otherwise
  // falls back to showing the session_token (a multi-hundred-char JWT)
  // in the Password field, which is unusable in a desktop RustDesk
  // client's password box. The rustdesk_pass is short (8 hex chars)
  // and is the actual permanent password set on the agent's RustDesk
  // via `rustdesk --password <pw>`.
  await admin.channel(`session:${sessionId}`)
    .send({
      type: "broadcast", event: "remote.ready",
      payload: {
        session_id: sessionId,
        rustdesk_id: rustdeskId,
        rustdesk_pass: body.rustdesk_pass ?? null,
      },
    });

  return json({ ok: true, state: "publishing" });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
