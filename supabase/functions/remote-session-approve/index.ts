// POST /functions/v1/remote-session-approve
// Caller: AGENT (X-Agent-Token: <enroll_token>).
// Body:   { session_id: uuid, decision: 'allow'|'deny'|'once' }
//
// The agent calls this after the employee answers the consent prompt
// (or the consent step is skipped due to org auto-approval policy).
// `decision='once'` means "approve this session AND don't update the
// permission's trusted_until window" — used when the employee hits
// "Allow once" instead of "Always allow for 8 h".
//
// State transitions:
//   requested → approved   (decision='allow' or 'once')
//   requested → denied     (decision='deny')
//   already approved/active → no-op (idempotent for retries)
//
// On 'allow' with the agent's consent_ttl_hours > 0, also bump the
// remote_permissions row's trusted_until so subsequent sessions skip
// the consent prompt for the configured window.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Decision = "allow" | "deny" | "once";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";
  if (!xAgent) return json({ error: "missing X-Agent-Token" }, 401);

  let body: { session_id?: string; decision?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const sessionId = (body.session_id ?? "").trim();
  const decision = (body.decision ?? "").trim() as Decision;
  if (!sessionId) return json({ error: "session_id required" }, 400);
  if (!["allow", "deny", "once"].includes(decision)) {
    return json({ error: "decision must be allow | deny | once" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- Agent auth ----
  const { data: agent } = await admin
    .from("agents")
    .select("id, org_id")
    .eq("enroll_token", xAgent)
    .maybeSingle();
  if (!agent) return json({ error: "invalid agent token" }, 401);
  const agentId = (agent as { id: string }).id;
  const orgId   = (agent as { org_id: string }).org_id;

  // ---- Load session + verify ownership ----
  const { data: session } = await admin
    .from("remote_sessions")
    .select("id, agent_id, state, viewer_user_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return json({ error: "session not found" }, 404);
  if ((session as { agent_id: string }).agent_id !== agentId) {
    return json({ error: "session does not belong to this agent" }, 403);
  }
  const currentState = (session as { state: string }).state;
  // Idempotency: a retry on an already-approved session is success.
  if (["approved", "publishing", "active"].includes(currentState) && decision !== "deny") {
    return json({ ok: true, state: currentState, idempotent: true });
  }
  if (currentState === "ended") {
    return json({ error: "session already ended" }, 409);
  }

  // ---- Update session state ----
  const nextState = decision === "deny" ? "denied" : "approved";
  const update: Record<string, unknown> = {
    state: nextState,
    approved_at: nextState === "approved" ? new Date().toISOString() : null,
    failure_reason: nextState === "denied" ? "employee_declined" : null,
  };
  const { error: updErr } = await admin
    .from("remote_sessions")
    .update(update)
    .eq("id", sessionId);
  if (updErr) return json({ error: `state update: ${updErr.message}` }, 500);

  // ---- If 'allow' (not 'once'), update permission window ----
  if (decision === "allow") {
    // Read the policy that applies (per-agent first, then org default).
    const { data: permRows } = await admin
      .from("remote_permissions")
      .select("id, agent_id, consent_ttl_hours")
      .eq("org_id", orgId)
      .or(`agent_id.eq.${agentId},agent_id.is.null`);
    type P = { id: string; agent_id: string | null; consent_ttl_hours: number };
    const perAgent = (permRows ?? []).find((p) => (p as P).agent_id === agentId) as P | undefined;
    const orgDefault = (permRows ?? []).find((p) => (p as P).agent_id === null) as P | undefined;
    const ttl = (perAgent ?? orgDefault)?.consent_ttl_hours ?? 0;
    if (ttl > 0) {
      const trustedUntil = new Date(Date.now() + ttl * 3_600_000).toISOString();
      // If a per-agent row exists, bump it; otherwise create one so the
      // "Always allow" choice is remembered per agent (not per org —
      // employees on different machines may have different preferences).
      if (perAgent) {
        await admin.from("remote_permissions")
          .update({ trusted_until: trustedUntil, updated_at: new Date().toISOString() })
          .eq("id", perAgent.id);
      } else {
        await admin.from("remote_permissions").insert({
          org_id: orgId, agent_id: agentId,
          enabled: true, require_consent: true,
          consent_ttl_hours: ttl, trusted_until: trustedUntil,
        });
      }
    }
  }

  // ---- Audit ----
  await admin.from("remote_audit_logs").insert([
    {
      session_id: sessionId, org_id: orgId,
      actor_kind: "employee", action: "consent_shown",
      metadata: {},
    },
    {
      session_id: sessionId, org_id: orgId,
      actor_kind: "employee", action: "consent_decision",
      metadata: { decision },
    },
  ]);

  // ---- Realtime broadcast to dashboard ----
  // Dashboard subscribes to `session:<id>` to drive state transitions
  // in the React UI without polling.
  await admin.channel(`session:${sessionId}`)
    .send({
      type: "broadcast",
      event: "remote.consent_decision",
      payload: { session_id: sessionId, decision, next_state: nextState },
    });

  return json({ ok: true, state: nextState });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
