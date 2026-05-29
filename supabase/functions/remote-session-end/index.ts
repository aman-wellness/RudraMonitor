// POST /functions/v1/remote-session-end
// Caller: EITHER admin (Authorization: Bearer <user JWT>)
//                OR agent (X-Agent-Token: <enroll_token>).
// Body:   { session_id: uuid, reason?: string }
//
// Either side can end a session. Updates state='ended', sets ended_at,
// broadcasts to BOTH the dashboard channel (so a stuck iframe can
// tear down) AND the agent channel (so the rustdesk subprocess gets
// killed if it's still running).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { session_id?: string; reason?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const sessionId = (body.session_id ?? "").trim();
  const reason = (body.reason ?? "").trim().slice(0, 280);
  if (!sessionId) return json({ error: "session_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve caller — either side can end. The audit log records WHO.
  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";
  const userAuth = req.headers.get("authorization") ?? "";
  const userJwt = userAuth.toLowerCase().startsWith("bearer ") ? userAuth.slice(7).trim() : "";

  let actorKind: "admin" | "agent" = "admin";
  let actorUserId: string | null = null;
  let agentIdForOwnership: string | null = null;
  let orgIdForAudit: string;

  // Load session first so we have agent_id + org_id either way.
  const { data: session } = await admin
    .from("remote_sessions")
    .select("id, agent_id, org_id, state, viewer_user_id")
    .eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "session not found" }, 404);
  const s = session as { id: string; agent_id: string; org_id: string; state: string; viewer_user_id: string };
  orgIdForAudit = s.org_id;

  if (xAgent) {
    const { data: a } = await admin.from("agents").select("id, org_id")
      .eq("enroll_token", xAgent).maybeSingle();
    if (!a) return json({ error: "invalid agent token" }, 401);
    if ((a as { id: string }).id !== s.agent_id) {
      return json({ error: "session does not belong to this agent" }, 403);
    }
    actorKind = "agent";
    agentIdForOwnership = s.agent_id;
  } else if (userJwt) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${userJwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return json({ error: "invalid user token" }, 401);
    // Must be admin/owner in the session's org.
    const { data: m } = await admin.from("org_members").select("role")
      .eq("user_id", u.user.id).eq("org_id", s.org_id).maybeSingle();
    if (!m || !["admin", "owner"].includes(String((m as { role: string }).role))) {
      return json({ error: "admin or owner required to end session" }, 403);
    }
    actorKind = "admin";
    actorUserId = u.user.id;
  } else {
    return json({ error: "missing auth (Bearer JWT or X-Agent-Token)" }, 401);
  }

  // Idempotency: if already ended, return success.
  if (s.state === "ended" || s.state === "failed" || s.state === "expired") {
    return json({ ok: true, state: s.state, idempotent: true });
  }

  const { error: updErr } = await admin
    .from("remote_sessions")
    .update({
      state: "ended",
      ended_at: new Date().toISOString(),
      failure_reason: reason || null,
    })
    .eq("id", sessionId);
  if (updErr) return json({ error: `state update: ${updErr.message}` }, 500);

  await admin.from("remote_audit_logs").insert({
    session_id: sessionId, org_id: orgIdForAudit,
    actor_kind: actorKind, actor_user_id: actorUserId,
    action: "session_ended",
    metadata: { reason, from_state: s.state },
  });

  // Broadcast to both ends — Realtime is best-effort, so each side ALSO
  // polls remote_sessions.state via the Realtime postgres-changes channel.
  await admin.channel(`session:${sessionId}`).send({
    type: "broadcast", event: "remote.ended",
    payload: { session_id: sessionId, ended_by: actorKind },
  });
  await admin.channel(`agent:${s.agent_id}`).send({
    type: "broadcast", event: "remote.ended",
    payload: { session_id: sessionId, ended_by: actorKind },
  });

  return json({ ok: true, state: "ended" });
  void agentIdForOwnership; // referenced for symmetry, no further use
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
