// POST /functions/v1/webrtc-turn-credentials
// Body: {} (no payload)
// Auth: either a user JWT (dashboard) OR an agent enroll_token (agent).
//
// Returns a short-lived TURN credential pair that the caller plugs into an
// RTCPeerConnection. Coturn validates the HMAC locally — no per-request DB
// hit — so this scales cleanly to 100+ agents and many dashboard viewers.
//
// HMAC scheme (coturn `use-auth-secret` mode):
//   username   = "<unix-expiry>:<owner-id>"
//   credential = base64( HMAC-SHA1(static-auth-secret, username) )
// Owner-id is the caller's identity (auth.uid for dashboard, agent_id for
// the agent) — purely informational; coturn doesn't enforce it but it
// makes the auth audit log readable.
//
// TTL is 4 hours by default — long enough for an extended live-monitoring
// session, short enough that a leaked credential can't be reused tomorrow.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TURN_SECRET = Deno.env.get("TURN_SHARED_SECRET") ?? "";
// Default points at the production Supabase host, which is the same host
// that fronts coturn (single-box deploy). MUST resolve to exactly one IP:
// `rudrans.com` used to sit here, but its DNS returns TWO A records
// (65.0.93.60 alongside 18.145.223.204) — the browser round-robin
// occasionally picks the dead IP and the whole ICE gather stalls with
// "no usable network path within 8s". `api-ems.wellnessextract.com`
// resolves to a single live IP, so every candidate the client tries is
// reachable.
const TURN_HOST = Deno.env.get("TURN_HOST") ?? "api-ems.wellnessextract.com";
// TLS host must match the CN/SAN on coturn's certificate. Defaults to TURN_HOST
// because that is the common single-box setup, but is overridable for a relay
// whose cert is on a different name.
const TURN_TLS_HOST = Deno.env.get("TURN_TLS_HOST") ?? TURN_HOST;
// The plain UDP/TCP relay port. 3478 is the IANA default.
const TURN_PORT = Deno.env.get("TURN_PORT") ?? "3478";
// Geo-nearer secondary relay. When set, its UDP/TCP entries are prepended to
// the iceServers list so ICE prefers the low-latency path (India → India stays
// ~30-50 ms round-trip vs ~450 ms via the US primary). Shares the same
// static-auth-secret as the primary — the HMAC username/credential this edge
// fn issues authenticates against either relay identically. Optional: unset =
// original single-relay behavior.
const TURN_HOST_IN = Deno.env.get("TURN_HOST_IN") ?? "13.233.159.137";
// The TLS relay port. 443 is deliberate, not a placeholder: TURN-over-TLS on
// 443 is the ONE transport that reaches a client on essentially any network,
// because to every firewall in between it looks exactly like an HTTPS
// connection. This is what makes remote access work from a home, a hotel, a
// phone tether, or a locked-down office in another country. Overridable only
// if 443 is already taken on the relay host.
const TURN_TLS_PORT = Deno.env.get("TURN_TLS_PORT") ?? "443";
const TTL_SECONDS = 4 * 60 * 60; // 4 hours

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }
  if (!TURN_SECRET) {
    return json({ error: "TURN_SHARED_SECRET not configured on server" }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve caller identity. Two valid paths: user JWT or agent enroll_token.
  // Dashboard sends the JWT in Authorization; agent sends its enroll token
  // either as Bearer or X-Agent-Token.
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";

  let ownerId = "";

  if (xAgent) {
    const { data: agent } = await admin
      .from("agents")
      .select("id")
      .eq("enroll_token", xAgent)
      .maybeSingle();
    if (agent) ownerId = `agent-${agent.id}`;
  }

  if (!ownerId && bearer) {
    // Try as user JWT first.
    const { data: userRes } = await admin.auth.getUser(bearer);
    if (userRes?.user) ownerId = `user-${userRes.user.id}`;
    else {
      // Fall back to treating the bearer as an enroll_token (some clients
      // ship it via the Authorization header to avoid X-* CORS preflight).
      const { data: agent } = await admin
        .from("agents")
        .select("id")
        .eq("enroll_token", bearer)
        .maybeSingle();
      if (agent) ownerId = `agent-${agent.id}`;
    }
  }

  if (!ownerId) return json({ error: "unauthenticated" }, 401);

  // Build HMAC credential pair. `username` is plaintext (coturn parses it
  // for the expiry check), `credential` is the HMAC over that username.
  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const username = `${expiry}:${ownerId}`;
  const credential = await hmacSha1Base64(TURN_SECRET, username);

  return json({
    username,
    credential,
    ttl: TTL_SECONDS,
    // RTCPeerConnection accepts the `iceServers` array directly — caller
    // can usually pass this through verbatim.
    // Each transport on its own iceServers entry. webrtc-rs 0.13 has shown
    // issues when given a bundled `urls: [...]` array — it allocates a
    // relay but then never sends binding responses through it. Splitting
    // keeps each ICE candidate gathering pass simple. We also drop the
    // TCP/TURNS variants for now: the TLS listener isn't configured
    // (Let's Encrypt cert path missing in coturn config), and TCP-TURN
    // adds head-of-line blocking we don't want for screen video.
    // Order matters for LATENCY. ICE gathers candidates from all of these and
    // then uses the best pair it can actually connect, so the list is arranged
    // cheapest-path-first:
    //
    //   1. STUN — discovers the public address for a DIRECT peer-to-peer path.
    //      When it works (most home and mobile networks), media never touches
    //      the relay and latency is the raw network round-trip. This is the
    //      common case and the fast one.
    //   2. TURN over UDP — relay fallback with the least overhead, for when
    //      direct fails but UDP still flows.
    //   3. TURN over TCP — for networks that pass TCP but drop UDP.
    //   4. TURN over TLS/443 — the last resort that works almost everywhere,
    //      at the cost of an extra hop. Only used when 1–3 all fail.
    //
    // Because relay is last, a well-connected viewer/agent pays no relay
    // latency; a badly-firewalled one still connects. That is the whole point:
    // fast when possible, reachable always.
    iceServers: [
      // India-nearer relay first (lowest latency for the current fleet).
      ...(TURN_HOST_IN
        ? [
            { urls: `stun:${TURN_HOST_IN}:${TURN_PORT}` },
            {
              urls: `turn:${TURN_HOST_IN}:${TURN_PORT}?transport=udp`,
              username,
              credential,
            },
            {
              urls: `turn:${TURN_HOST_IN}:${TURN_PORT}?transport=tcp`,
              username,
              credential,
            },
          ]
        : []),
      // US primary — fallback if the India path is blocked or the peer is
      // actually closer to the US relay.
      { urls: `stun:${TURN_HOST}:${TURN_PORT}` },
      {
        urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
        username,
        credential,
      },
      {
        urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
        username,
        credential,
      },
      {
        urls: `turns:${TURN_TLS_HOST}:${TURN_TLS_PORT}?transport=tcp`,
        username,
        credential,
      },
    ],
  });
});

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  // btoa expects a binary string
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
