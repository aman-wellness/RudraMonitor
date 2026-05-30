// POST /functions/v1/remote-session-start
// Caller: admin/owner from dashboard. Authorization: Bearer <user JWT>.
// Body:   { agent_id: uuid, reason?: string }
//
// What it does:
//   1. Authorise — caller must be admin/owner in the agent's org.
//   2. Honour remote_permissions policy:
//        • enabled=false  → 403
//        • trusted_admins set + caller not in list → 403
//   3. Reuse an active session if one already exists for this agent
//      (idempotent — dashboard reconnects fall back to existing session
//      instead of creating duplicates that confuse the agent).
//   4. Create remote_sessions row (state='requested') + a short-lived
//      JWT scoped to that session.
//   5. Broadcast Supabase Realtime event `remote.request` on channel
//      `agent:<agent_id>` so the agent picks it up immediately.
//   6. Mirror to remote_audit_logs (action='request_sent').
//   7. Return session info + JWT to the dashboard.
//
// Decision: we do NOT pre-mint a RustDesk ID here. The agent will spawn
// its rustdesk subprocess after consent and report back the ID via
// /remote-session-ready. Pre-minting would require us to run a RustDesk
// admin RPC against hbbs from the edge function which adds complexity
// for no real benefit — the agent's ID is naturally globally-unique.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { create as createJwt, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
// RustDesk infrastructure exposed to clients. The agent dials the same
// public host on the native TCP/UDP ports (21115/21116/21117); the
// dashboard's browser viewer dials the WSS bridge under /rustdesk-relay/.
const RUSTDESK_SERVER   = Deno.env.get("RUSTDESK_SERVER") ?? "api.rudrans.com";
// HS256 secret used to sign the per-session JWT we hand back to both
// the dashboard and the agent. Different from LIVEKIT_API_SECRET so a
// LiveKit token can't be replayed as a RustDesk token.
// Self-hosted Supabase exposes the JWT signing secret as `JWT_SECRET`
// (cloud Supabase uses SUPABASE_JWT_SECRET). Fall back through both so
// the fn works in either runtime without extra env wiring.
const RD_SESSION_SECRET = Deno.env.get("RD_SESSION_SECRET")
  ?? Deno.env.get("SUPABASE_JWT_SECRET")
  ?? Deno.env.get("JWT_SECRET")
  ?? "";
if (!RD_SESSION_SECRET) {
  console.error("remote-session-start: no JWT secret configured (RD_SESSION_SECRET / SUPABASE_JWT_SECRET / JWT_SECRET all unset)");
}
const SESSION_TTL_SECS  = 30 * 60; // 30 minutes is plenty for a single session

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // ---- AuthN: resolve caller via user JWT ----
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: userErr } = await userClient.auth.getUser();
  if (userErr || !u.user) return json({ error: "invalid token" }, 401);
  const callerId = u.user.id;

  // ---- Body ----
  let body: { agent_id?: string; reason?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const agentId = (body.agent_id ?? "").trim();
  const reason  = (body.reason ?? "").trim().slice(0, 280);
  if (!agentId) return json({ error: "agent_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- AuthZ: caller must be admin/owner in the agent's org ----
  const { data: agent } = await admin
    .from("agents")
    .select("id, org_id, agent_name, machine_name, status")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return json({ error: "agent not found" }, 404);
  const orgId = (agent as { org_id: string }).org_id;

  const { data: member } = await admin
    .from("org_members")
    .select("role")
    .eq("user_id", callerId)
    .eq("org_id", orgId)
    .maybeSingle();
  const role = String((member as { role?: string } | null)?.role ?? "");
  if (!member || !["admin", "owner"].includes(role)) {
    return json({ error: "remote desktop requires admin or owner role" }, 403);
  }

  // ---- Policy: remote_permissions check ----
  // Look up the per-agent row, fall back to the org-default row, fall
  // back to "enabled + require consent" defaults if neither exists.
  const { data: permRows } = await admin
    .from("remote_permissions")
    .select("enabled, require_consent, consent_ttl_hours, trusted_admins, trusted_until, agent_id")
    .eq("org_id", orgId)
    .or(`agent_id.eq.${agentId},agent_id.is.null`);
  type Perm = {
    enabled: boolean; require_consent: boolean; consent_ttl_hours: number;
    trusted_admins: string[] | null; trusted_until: string | null; agent_id: string | null;
  };
  const perAgent = (permRows ?? []).find((p) => (p as Perm).agent_id === agentId) as Perm | undefined;
  const orgDefault = (permRows ?? []).find((p) => (p as Perm).agent_id === null) as Perm | undefined;
  const policy = perAgent ?? orgDefault ?? {
    enabled: true, require_consent: true, consent_ttl_hours: 0,
    trusted_admins: null, trusted_until: null, agent_id: null,
  };
  if (!policy.enabled) {
    return json({ error: "remote desktop disabled for this agent (policy)" }, 403);
  }
  if (policy.trusted_admins?.length && !policy.trusted_admins.includes(callerId)) {
    return json({ error: "you are not in the trusted-admins list for this agent" }, 403);
  }

  // Auto-approve if the policy's "Always allow" window is still open.
  const autoApprove =
    !policy.require_consent
    || (policy.trusted_until && new Date(policy.trusted_until) > new Date());
  const initialState = autoApprove ? "approved" : "requested";

  // ---- Idempotency: reuse an active session if there is one ----
  const { data: existing } = await admin
    .from("remote_sessions")
    .select("id, state, session_token_jti")
    .eq("agent_id", agentId)
    .in("state", ["requested", "consent_pending", "approved", "publishing", "active"])
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    // Mint a FRESH JWT pointing at the existing session id so the
    // dashboard can still subscribe without leaking the old token.
    const sid = (existing as { id: string }).id;
    const tok = await mintSessionJwt(sid, agentId, orgId, callerId);
    return json({
      session_id: sid,
      rustdesk_server: RUSTDESK_SERVER,
      session_token: tok.token,
      session_token_jti: tok.jti,
      expires_at: new Date(tok.exp * 1000).toISOString(),
      state: (existing as { state: string }).state,
      reused: true,
    });
  }

  // ---- Insert new session row ----
  const ipAddress = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent") ?? null;

  const { data: inserted, error: insertErr } = await admin
    .from("remote_sessions")
    .insert({
      org_id: orgId,
      agent_id: agentId,
      viewer_user_id: callerId,
      state: initialState,
      reason: reason || null,
      approved_at: autoApprove ? new Date().toISOString() : null,
      client_ip: ipAddress,
      client_ua: userAgent,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return json({ error: `session insert: ${insertErr?.message ?? "unknown"}` }, 500);
  }
  const sessionId = (inserted as { id: string }).id;

  // ---- Mint per-session JWT ----
  const tok = await mintSessionJwt(sessionId, agentId, orgId, callerId);
  await admin
    .from("remote_sessions")
    .update({ session_token_jti: tok.jti })
    .eq("id", sessionId);

  // ---- Audit log ----
  await admin.from("remote_audit_logs").insert({
    session_id: sessionId,
    org_id: orgId,
    actor_kind: "admin",
    actor_user_id: callerId,
    action: "request_sent",
    metadata: { reason, auto_approve: autoApprove, policy_source: perAgent ? "agent" : (orgDefault ? "org" : "default") },
    ip_address: ipAddress,
    user_agent: userAgent,
  });

  // ---- Realtime broadcast to the agent ----
  // The agent's realtime_listener task subscribes to `agent:<id>` and
  // dispatches `remote.request` payloads into the consent + rustdesk
  // bring-up pipeline.
  await admin.channel(`agent:${agentId}`)
    .send({
      type: "broadcast",
      event: "remote.request",
      payload: {
        session_id: sessionId,
        viewer_user_id: callerId,
        viewer_name: u.user.user_metadata?.full_name ?? u.user.email ?? "Admin",
        reason: reason || null,
        rustdesk_server: RUSTDESK_SERVER,
        session_token: tok.token,
        auto_approved: autoApprove,
        expires_at: new Date(tok.exp * 1000).toISOString(),
      },
    });

  return json({
    session_id: sessionId,
    rustdesk_server: RUSTDESK_SERVER,
    session_token: tok.token,
    session_token_jti: tok.jti,
    expires_at: new Date(tok.exp * 1000).toISOString(),
    state: initialState,
    reused: false,
  }, 201);
});

// ============================================================
// JWT helper — HS256 over a small claim set. Validated by:
//   • the agent (verifies signature before launching rustdesk subprocess)
//   • the dashboard (passed to the rustdesk-web iframe; iframe ignores it
//     for now but it's available if we ever add per-session WSS auth at
//     the nginx layer).
// ============================================================
async function mintSessionJwt(
  sessionId: string, agentId: string, orgId: string, viewerUserId: string,
): Promise<{ token: string; jti: string; exp: number }> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(RD_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  const jti = crypto.randomUUID();
  const exp = getNumericDate(SESSION_TTL_SECS);
  const token = await createJwt(
    { alg: "HS256", typ: "JWT" },
    {
      iss: "rudrans-rd",
      sub: sessionId,
      jti,
      nbf: getNumericDate(0),
      exp,
      agent_id: agentId,
      org_id: orgId,
      viewer_user_id: viewerUserId,
      scope: "remote.session",
    },
    key,
  );
  return { token, jti, exp: exp as number };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
