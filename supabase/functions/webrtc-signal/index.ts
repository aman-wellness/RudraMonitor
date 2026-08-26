// WebRTC signaling relay.
//
// Routes:
//   POST /functions/v1/webrtc-signal
//     Body: { session_id, agent_id, direction, kind, payload }
//     Posts a message (offer/answer/ICE candidate) into the signaling table.
//     The dashboard sends `direction=to_agent`; the agent sends `direction=to_dashboard`.
//
//   GET  /functions/v1/webrtc-signal?session_id=...&direction=to_agent&since=ISO
//     Long-poll for new messages. Returns immediately if any rows are
//     available newer than `since`; otherwise blocks up to ~25 seconds
//     (HTTP keepalive friendly, sub-Cloudflare 30s edge timeout) and
//     re-checks every POLL_INTERVAL_MS before returning whatever it sees.
//
//     CALLERS MUST USE AN HTTP TIMEOUT GREATER THAN LONG_POLL_TIMEOUT_MS.
//     The agent shipped a 20s client timeout against this 25s hold, so every
//     idle poll aborted client-side and was treated as a connection failure —
//     the agent then backed off 10s, going deaf to Live View start triggers
//     for about a third of every cycle. See api::LONG_POLL_TIMEOUT agent-side.
//
// Auth model mirrors webrtc-turn-credentials:
//   - Dashboard: user JWT in Authorization header, must be an org member
//     of the agent's org_id.
//   - Agent:    enroll_token in X-Agent-Token, must match the agent_id.
//
// We intentionally use HTTP long-poll (not WebSocket) because the Rust
// agent doesn't have a Supabase Realtime client. Dashboards COULD use
// Supabase Realtime broadcast directly but the symmetric HTTP API keeps
// both sides on the same code path — easier to debug end-to-end.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Direction = "to_agent" | "to_dashboard";
// Legacy DIY signaling kinds + LiveKit-pivot trigger kinds. The LiveKit
// pair (`livekit_start` / `livekit_stop`) carry no SDP payload — they
// just tell the agent's whip_publisher to start / stop publishing into
// the LiveKit room. We accept both during the dual-stack rollout window;
// Block G of the pivot deletes the offer/answer/ice_candidate handlers
// once auto-update telemetry shows ≥95% of agents on v0.2.52+.
type Kind =
  | "offer" | "answer" | "ice_candidate"
  | "livekit_start" | "livekit_stop";

const LONG_POLL_TIMEOUT_MS = 10_000;
// ADAPTIVE poll interval. A flat 100 ms tick meant every agent — including the
// vast majority that are IDLE (no active session) — ran a DB query 10×/sec for
// the full long-poll, forever. At fleet scale that saturated the edge runtime's
// CPU budget, so its supervisor started terminating isolates mid-request
// ("WorkerRequestCancelled" → HTTP 500), which broke Live/Remote signalling and
// spilled over into other edge functions (e.g. settings delivery, so USB-block
// toggles stopped reaching agents).
//
// We ramp from a fast start (so an active offer/answer/ICE exchange still wires
// up in ~1 s) up to a 1 s ceiling (so an idle long-poll costs ~1 query/sec, a
// ~10× load reduction). Over a 20 s window that's ~25 queries vs. the old ~250.
const POLL_INTERVAL_START_MS = 200;
const POLL_INTERVAL_MAX_MS = 1_000;
const POLL_INTERVAL_STEP_MS = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve caller: either an authenticated dashboard user or an agent
  // identified by its enroll token. Both produce an `orgId` we use to
  // scope the signaling row reads/writes.
  const caller = await resolveCaller(req, admin);
  if (!caller) return json({ error: "unauthenticated" }, 401);

  if (req.method === "GET") {
    return await handleGet(req, url, admin, caller);
  }
  if (req.method === "POST") {
    return await handlePost(req, admin, caller);
  }
  return json({ error: "method not allowed" }, 405);
});

interface Caller {
  type: "user" | "agent";
  userId?: string;
  agentId?: string;
  orgId: string;
}

async function resolveCaller(
  req: Request,
  admin: ReturnType<typeof createClient>,
): Promise<Caller | null> {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";

  if (xAgent) {
    const { data: agent } = await admin
      .from("agents")
      .select("id, org_id")
      .eq("enroll_token", xAgent)
      .maybeSingle();
    if (agent) {
      return {
        type: "agent",
        agentId: String((agent as { id: string }).id),
        orgId: String((agent as { org_id: string }).org_id),
      };
    }
  }
  if (bearer) {
    const { data: userRes } = await admin.auth.getUser(bearer);
    if (userRes?.user) {
      // Resolve the user's org via org_members (one user can belong to
      // multiple orgs in principle; for signaling we'll derive the org
      // from the agent_id at request time, not the user).
      return { type: "user", userId: userRes.user.id, orgId: "" };
    }
    // Bearer might still be an enroll_token (some HTTP clients prefer
    // sending tokens via Authorization to dodge CORS preflight on X-*).
    const { data: agent } = await admin
      .from("agents")
      .select("id, org_id")
      .eq("enroll_token", bearer)
      .maybeSingle();
    if (agent) {
      return {
        type: "agent",
        agentId: String((agent as { id: string }).id),
        orgId: String((agent as { org_id: string }).org_id),
      };
    }
  }
  return null;
}

async function handlePost(
  req: Request,
  admin: ReturnType<typeof createClient>,
  caller: Caller,
): Promise<Response> {
  let body: {
    session_id?: string;
    agent_id?: string;
    direction?: Direction;
    kind?: Kind;
    payload?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const sessionId = (body.session_id ?? "").trim();
  const agentId = (body.agent_id ?? "").trim();
  const direction = body.direction;
  const kind = body.kind;
  const payload = body.payload;

  if (!sessionId || !agentId || !direction || !kind || payload === undefined) {
    return json({ error: "session_id, agent_id, direction, kind, payload required" }, 400);
  }
  if (direction !== "to_agent" && direction !== "to_dashboard") {
    return json({ error: "direction must be to_agent or to_dashboard" }, 400);
  }
  if (!["offer", "answer", "ice_candidate", "livekit_start", "livekit_stop"].includes(kind)) {
    return json({ error: "kind must be offer | answer | ice_candidate | livekit_start | livekit_stop" }, 400);
  }

  // Authorization checks:
  //   - Agent callers can only post `direction=to_dashboard` and only for
  //     their own agent_id.
  //   - User callers can only post `direction=to_agent` and only for
  //     agents in an org they're a member of.
  let orgId: string;
  if (caller.type === "agent") {
    if (direction !== "to_dashboard") {
      return json({ error: "agents can only send direction=to_dashboard" }, 403);
    }
    if (caller.agentId !== agentId) {
      return json({ error: "agent_id mismatch with token" }, 403);
    }
    orgId = caller.orgId;
  } else {
    // user
    if (direction !== "to_agent") {
      return json({ error: "users can only send direction=to_agent" }, 403);
    }
    const { data: agentRow } = await admin
      .from("agents")
      .select("org_id")
      .eq("id", agentId)
      .maybeSingle();
    if (!agentRow) return json({ error: "agent not found" }, 404);
    orgId = String((agentRow as { org_id: string }).org_id);
    const { data: member } = await admin
      .from("org_members")
      .select("role")
      .eq("user_id", caller.userId!)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!member) return json({ error: "not an org member" }, 403);

    // Remote-Desktop gate. An offer whose SDP contains `m=application`
    // requests a data channel — only admins/owners can remote-control.
    // Live (video-only) offers go through with normal org membership.
    // We also mint an audit row in `remote_sessions` here so we always
    // know who tried (even if the connection ultimately fails).
    if (kind === "offer") {
      const sdp = typeof (payload as { sdp?: string })?.sdp === "string"
        ? (payload as { sdp: string }).sdp
        : "";
      if (sdp.includes("m=application")) {
        const role = String((member as { role: string }).role ?? "");
        if (role !== "admin" && role !== "owner") {
          return json({ error: "remote control requires admin role" }, 403);
        }
        // Idempotent upsert on session_id (UNIQUE in the table). Same
        // session re-posting offer (e.g. after ICE restart) won't dupe.
        await admin.from("remote_sessions").upsert({
          session_id: sessionId,
          org_id: orgId,
          agent_id: agentId,
          controller_user: caller.userId!,
        }, { onConflict: "session_id" });
      }
    }
  }

  // Agent → dashboard `answer`: if a remote_sessions row exists for this
  // session, mark it as started (i.e. the agent acknowledged the offer).
  if (caller.type === "agent" && kind === "answer") {
    await admin
      .from("remote_sessions")
      .update({ started_at: new Date().toISOString() })
      .eq("session_id", sessionId)
      .is("started_at", null);
  }

  const { error: insertErr } = await admin.from("webrtc_signaling").insert({
    session_id: sessionId,
    agent_id: agentId,
    org_id: orgId,
    direction,
    kind,
    payload,
  });
  if (insertErr) return json({ error: `insert: ${insertErr.message}` }, 500);

  // Deliver `to_agent` messages over Realtime broadcast so the agent no longer
  // has to long-poll this function — that continuous poll, held open by every
  // agent 24/7, saturated the edge runtime's CPU budget ("WorkerRequestCancelled"
  // → 500s across all functions). The agent's realtime_listener subscribes to
  // `agent:<id>` and dispatches these events (livekit_start/stop today; offer/
  // ice_candidate once the Remote slice lands). The DB insert above stays for
  // audit/replay and as a fallback for any client still polling. Same broadcast
  // mechanism the RustDesk `remote.request` path already uses successfully.
  if (direction === "to_agent") {
    try {
      const status = await admin.channel(`agent:${agentId}`).send({
        type: "broadcast",
        event: kind,
        payload: {
          session_id: sessionId,
          ...(payload && typeof payload === "object" ? payload as Record<string, unknown> : {}),
        },
      });
      if (status !== "ok") {
        console.error(`webrtc-signal broadcast ${kind} to agent:${agentId} returned "${status}"`);
      }
    } catch (e) {
      console.error(
        `webrtc-signal broadcast ${kind} to agent:${agentId} threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return json({ ok: true });
}

async function handleGet(
  req: Request,
  url: URL,
  admin: ReturnType<typeof createClient>,
  caller: Caller,
): Promise<Response> {
  // session_id is OPTIONAL for agents — they typically don't know the
  // dashboard's session_id until an offer arrives, so they poll broadly
  // (filtered by their agent_id via X-Agent-Token) looking for incoming
  // offers. Dashboards always supply session_id because they own it.
  const sessionId = url.searchParams.get("session_id")?.trim() ?? "";
  const directionParam = url.searchParams.get("direction") ?? "";
  const since = url.searchParams.get("since") ?? new Date(0).toISOString();
  if (directionParam !== "to_agent" && directionParam !== "to_dashboard") {
    return json({ error: "direction=to_agent|to_dashboard required" }, 400);
  }
  if (!sessionId && caller.type !== "agent") {
    return json({ error: "session_id required for non-agent callers" }, 400);
  }
  const direction: Direction = directionParam as Direction;

  // Authorization on read: agent fetches messages destined to itself,
  // user fetches messages destined to the dashboard for an agent in
  // their org. We re-check ownership here so a leaked token can't
  // listen in on someone else's session.
  if (caller.type === "agent" && direction !== "to_agent") {
    return json({ error: "agents can only poll direction=to_agent" }, 403);
  }
  if (caller.type === "user" && direction !== "to_dashboard") {
    return json({ error: "users can only poll direction=to_dashboard" }, 403);
  }

  // Long-poll: spin in POLL_INTERVAL_MS ticks until we see a row newer than
  // `since`, capped at LONG_POLL_TIMEOUT_MS. That cap only avoids tripping the
  // caller's HTTP timeout if the caller allows MORE than it — see the header
  // note; the agent did not, until this was found.
  // Using cancellation via AbortSignal would be cleaner but Deno's Deno.serve
  // doesn't expose request lifecycle hooks reliably across versions.
  const deadline = Date.now() + LONG_POLL_TIMEOUT_MS;
  let pollInterval = POLL_INTERVAL_START_MS;
  while (Date.now() < deadline) {
    // Build the row filter dynamically: agents without a session_id read
    // every "to_agent" message addressed to their agent_id (so they can
    // see incoming offers before knowing what session_id the dashboard
    // will use). Dashboards always supply session_id.
    let q = admin
      .from("webrtc_signaling")
      .select("id, kind, payload, created_at, agent_id, session_id")
      .eq("direction", direction)
      .gt("created_at", since)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(50);
    if (sessionId) {
      q = q.eq("session_id", sessionId);
    }
    if (caller.type === "agent" && caller.agentId) {
      q = q.eq("agent_id", caller.agentId);
    }
    const { data: rows } = await q;

    if (rows && rows.length > 0) {
      // SECURITY (audit M18): the user path never actually verified session
      // ownership (the old comment claimed it did). A user who knew any
      // session_id could read another org's SDP/ICE signaling. Bind user
      // callers to the org of the row's agent — the same membership check the
      // POST path does — and drop rows for agents outside their org(s).
      let allowedAgentIds: Set<string> | null = null;
      if (caller.type === "user") {
        const agentIds = [...new Set(rows.map((r) => String((r as { agent_id: string }).agent_id)))];
        const { data: ags } = await admin.from("agents").select("id, org_id").in("id", agentIds);
        const orgByAgent = new Map((ags ?? []).map((a) => [String((a as { id: string }).id), String((a as { org_id: string }).org_id)]));
        const orgIds = [...new Set([...orgByAgent.values()])];
        const { data: mems } = orgIds.length
          ? await admin.from("org_members").select("org_id").eq("user_id", caller.userId!).in("org_id", orgIds)
          : { data: [] as { org_id: string }[] };
        const memberOrgs = new Set((mems ?? []).map((m) => String((m as { org_id: string }).org_id)));
        allowedAgentIds = new Set(agentIds.filter((id) => memberOrgs.has(orgByAgent.get(id) ?? "")));
      }
      const safe = rows.filter((r) => {
        const rAgent = String((r as { agent_id: string }).agent_id);
        if (caller.type === "agent") return rAgent === caller.agentId;
        return allowedAgentIds!.has(rAgent); // user: only agents in the caller's org(s)
      });
      if (safe.length > 0) {
        return json({
          messages: safe.map((r) => ({
            id: r.id,
            kind: r.kind,
            payload: r.payload,
            created_at: r.created_at,
            // Surface session_id so the agent (which poll-broadcasts
            // before any session exists) can extract it from the
            // offer envelope and use it on its outbound POSTs.
            session_id: (r as { session_id?: string }).session_id ?? null,
          })),
        });
      }
    }

    await sleep(pollInterval);
    // Ramp toward the ceiling so an idle long-poll backs off to ~1 query/sec.
    pollInterval = Math.min(POLL_INTERVAL_MAX_MS, pollInterval + POLL_INTERVAL_STEP_MS);
  }

  return json({ messages: [] });
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
