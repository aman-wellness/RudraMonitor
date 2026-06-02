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
const TURN_HOST = Deno.env.get("TURN_HOST") ?? "ems.wellnessextract.com";
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
    iceServers: [
      { urls: `stun:${TURN_HOST}:3478` },
      {
        urls: `turn:${TURN_HOST}:3478?transport=udp`,
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
