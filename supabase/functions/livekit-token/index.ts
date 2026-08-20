// POST /functions/v1/livekit-token
// Body (agent): { agent_id }   Header: X-Agent-Token: <enroll_token>
// Body (user):  { agent_id }   Header: Authorization: Bearer <jwt>
//
// Mints a short-lived JWT signed with our LiveKit API secret that grants
// the caller permission to join exactly ONE room — `room.agent_<agent_id>`.
// Agents get `canPublish=true,canSubscribe=false` (they push their screen
// in but can't see other participants). Dashboard users get
// `canPublish=false,canSubscribe=true,canPublishData=true` (they pull
// the screen down + push mouse/keyboard events through the data channel).
//
// Replaces the old webrtc-turn-credentials + webrtc-signal pair. With
// LiveKit the SFU handles signaling, ICE, TURN, simulcast — we just
// hand the client a JWT and tell it which room to join.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { create as createJwt, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LIVEKIT_API_KEY = Deno.env.get("LIVEKIT_API_KEY")!;
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET")!;
// Public LiveKit endpoint the client connects to. nginx fronts our self-
// hosted server at https://api-ems.wellnessextract.com/livekit/.
const LIVEKIT_URL = Deno.env.get("LIVEKIT_URL") ?? "wss://api-ems.wellnessextract.com/livekit";
// Server-side address for the Twirp control API. Defaults to LIVEKIT_URL, which
// is right for the single-host nginx deployment, but they are NOT always the
// same: this function calls LiveKit from inside the container network while the
// value it returns is dialled by the BROWSER. Locally those are
// host.docker.internal vs 127.0.0.1; in k8s it's a cluster service vs a public
// ingress. Without the split, one of the two always fails.
const LIVEKIT_API_URL = Deno.env.get("LIVEKIT_API_URL") ?? LIVEKIT_URL;
// Base the AGENT posts its WHIP offer to. Optional; when unset we fall back to
// deriving it from LIVEKIT_URL, which assumes the shipped nginx layout (same
// host, /whip path, TLS). That assumption breaks anywhere WHIP is not
// co-hosted behind the same TLS terminator — including locally, where ingress
// is a separate service on :8080 over plain HTTP.
const LIVEKIT_WHIP_BASE = Deno.env.get("LIVEKIT_WHIP_BASE") ?? "";

type Body = { agent_id?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const agentId = (body.agent_id ?? "").trim();
  if (!agentId) return json({ error: "agent_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Two-headed auth: either a user JWT (dashboard caller) or an agent
  // enroll_token (agent caller). The role determines what permissions
  // we put on the LiveKit grant.
  const agentToken = req.headers.get("x-agent-token");
  const userAuth = req.headers.get("authorization");

  let identity = "";
  let canPublish = false;
  let canSubscribe = false;
  let canPublishData = false;

  if (agentToken) {
    // Agent caller — publishing its screen up to LiveKit.
    const { data: agent } = await admin
      .from("agents").select("id, org_id").eq("enroll_token", agentToken).maybeSingle();
    if (!agent || agent.id !== agentId) {
      return json({ error: "invalid agent token for this agent_id" }, 401);
    }
    identity = `agent-${agentId}`;
    canPublish = true;
    canPublishData = true; // for control-channel replies (clipboard, etc.)
  } else if (userAuth?.toLowerCase().startsWith("bearer ")) {
    // Dashboard user caller — subscribing to the agent's screen.
    const jwt = userAuth.slice(7).trim();
    const { data: userRes } = await admin.auth.getUser(jwt);
    const userId = userRes?.user?.id;
    if (!userId) return json({ error: "unauthenticated" }, 401);

    // Authorization: the user must belong to the same org as the agent
    // AND be an admin/owner of that org (matches the remote-session
    // gate the legacy webrtc-signal applied).
    const { data: agent } = await admin
      .from("agents").select("id, org_id").eq("id", agentId).maybeSingle();
    if (!agent) return json({ error: "agent not found" }, 404);
    const { data: member } = await admin
      .from("org_members").select("role").eq("org_id", agent.org_id).eq("user_id", userId).maybeSingle();
    if (!member || !["admin", "owner"].includes(String(member.role))) {
      return json({ error: "admin or owner role required" }, 403);
    }
    identity = `user-${userId}`;
    canSubscribe = true;
    canPublishData = true; // mouse/keyboard input over the data channel
  } else {
    return json({ error: "missing X-Agent-Token or Authorization header" }, 401);
  }

  const roomName = `agent_${agentId}`;
  const ttlSeconds = 60 * 60; // 1 hour; agents auto-refresh before expiry

  // Sign LiveKit's standard JWT: claims are HS256-signed with the API
  // secret, the `video` claim carries the room grant. djwt is the
  // minimal pure-Deno JWT library — no Node deps.
  // Fail with something diagnosable. Without this, an unset LIVEKIT_API_SECRET
  // reaches importKey as a zero-length key and throws
  // "DataError: Key length is zero" — a 500 with no hint that the cause is
  // configuration. Live View then shows a bare "Failed" pill.
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    const missing = [
      !LIVEKIT_API_KEY ? "LIVEKIT_API_KEY" : null,
      !LIVEKIT_API_SECRET ? "LIVEKIT_API_SECRET" : null,
    ].filter(Boolean).join(", ");
    console.error("livekit-token: not configured, missing", missing);
    return json({
      error: "live_view_not_configured",
      detail: `Live View is not configured on this server (missing ${missing}).`,
    }, 503);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(LIVEKIT_API_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const token = await createJwt(
    { alg: "HS256", typ: "JWT" },
    {
      iss: LIVEKIT_API_KEY,
      sub: identity,
      nbf: getNumericDate(0),
      exp: getNumericDate(ttlSeconds),
      name: identity,
      video: {
        room: roomName,
        roomJoin: true,
        canPublish,
        canSubscribe,
        canPublishData,
      },
    },
    key,
  );

  // If the caller is an agent (publisher role), ALSO create a LiveKit
  // Ingress resource. The WHIP endpoint /whip/<stream_key> only accepts
  // a pre-registered IngressInfo — the agent's JWT alone is not enough
  // to authenticate WHIP POSTs (the ingress server logs
  // "failed retrieving ingress info" otherwise).
  //
  // We use bypass_transcoding=true so frames pass through to subscribers
  // without re-encoding (~zero added latency, same H.264 stream the
  // agent's ffmpeg produces). LiveKit caps these at 1080p which is
  // plenty for our 1280x720 default.
  let ingressInfo: { ingress_id: string; url: string; stream_key: string } | null = null;
  if (canPublish) {
    // Admin JWT for the CreateIngress call — needs ingressAdmin claim.
    const adminToken = await createJwt(
      { alg: "HS256", typ: "JWT" },
      {
        iss: LIVEKIT_API_KEY,
        sub: "ingress-admin",
        nbf: getNumericDate(0),
        exp: getNumericDate(60), // 1 minute, just enough for this call
        video: { ingressAdmin: true },
      },
      key,
    );
    // Talk to the LiveKit server via the same nginx reverse-proxy the
    // dashboard uses, but on HTTP /livekit (not WS). The twirp endpoint
    // is at /livekit/twirp/livekit.Ingress/CreateIngress.
    const livekitHttp = LIVEKIT_API_URL
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:")
      .replace(/\/$/, "");
    const ingressResp = await fetch(
      `${livekitHttp}/twirp/livekit.Ingress/CreateIngress`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input_type: "WHIP_INPUT",
          name: `agent-${agentId}`,
          room_name: roomName,
          participant_identity: identity,
          participant_name: identity,
          bypass_transcoding: true,
        }),
      },
    );
    if (ingressResp.ok) {
      const body = await ingressResp.json() as {
        ingress_id?: string;
        url?: string;
        stream_key?: string;
      };
      // LiveKit Ingress returns `url: ""` when no public WHIP endpoint
      // is configured server-side — it expects the deployer to know
      // their own reverse-proxy mapping. We DO know ours: nginx routes
      // /whip/<stream_key> to localhost:8090. Build the URL here from
      // the public Supabase host (same host fronts both edge functions
      // and the LiveKit/Ingress stack via nginx).
      if (body.stream_key) {
        // Derive public WHIP base from livekit URL host. wss://api-ems.wellnessextract.com/livekit
        // → https://api-ems.wellnessextract.com/whip. Falls back to the request's
        // own origin (works when the dashboard + livekit share a host,
        // which is the only deployment shape we ship right now).
        const lkBase = LIVEKIT_URL
          .replace(/^wss?:/, "https:")
          .replace(/\/livekit\/?$/, "");
        // Order matters: an explicit override beats what the ingress service
        // reported, which in turn beats the nginx-shaped guess.
        const whipBase = LIVEKIT_WHIP_BASE.replace(/\/$/, "");
        const publicUrl = whipBase
          ? `${whipBase}/${body.stream_key}`
          : body.url && body.url.trim() !== ""
            ? body.url
            : `${lkBase}/whip/${body.stream_key}`;
        ingressInfo = {
          ingress_id: body.ingress_id ?? "",
          url: publicUrl,
          stream_key: body.stream_key,
        };
      }
    } else {
      const errBody = await ingressResp.text().catch(() => "");
      console.error("CreateIngress failed:", ingressResp.status, errBody);
    }
  }

  return json({
    url: LIVEKIT_URL,
    token,
    room: roomName,
    identity,
    expires_in: ttlSeconds,
    ingress: ingressInfo,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
