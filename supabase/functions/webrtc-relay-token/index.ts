// POST /functions/v1/webrtc-relay-token
// Body: { session: string, role: "agent" | "viewer" }
// Auth: user JWT (dashboard) OR agent enroll_token (agent) — same as
//       webrtc-turn-credentials.
//
// Returns a short-lived HMAC token the caller presents to the media relay
// (infra/relay/relay.ts) as ?token=..., plus the relay's WebSocket URL. The
// relay verifies the HMAC with the shared RELAY_SECRET and needs no DB hit, so
// this scales the same way the TURN credential minting does.
//
// This is the FALLBACK path's authentication. Clients try WebRTC first and
// only open the relay socket when ICE fails, so most sessions never call this.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") ?? "";
// wss URL of the relay, e.g. wss://relay.wellnessextract.com/ws
const RELAY_WSS_URL = Deno.env.get("RELAY_WSS_URL") ?? "";
const TTL_SECONDS = 2 * 60 * 60; // 2 hours — a long session, not indefinite.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!RELAY_SECRET || !RELAY_WSS_URL) {
    return json({ error: "relay not configured on server" }, 500);
  }

  let body: { session?: string; role?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const session = (body.session ?? "").trim();
  const role = body.role === "agent" ? "agent" : body.role === "viewer" ? "viewer" : "";
  if (!session || session.length > 128 || !role) {
    return json({ error: "session and role required" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve caller identity — user JWT or agent enroll_token, same two paths as
  // webrtc-turn-credentials. An agent may only take the "agent" role; a
  // dashboard user may only take "viewer". This stops an agent from attaching
  // as the viewer of another agent's session, or vice versa.
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";

  let callerKind: "agent" | "user" | "" = "";

  if (xAgent) {
    const { data: agent } = await admin.from("agents").select("id").eq("enroll_token", xAgent).maybeSingle();
    if (agent) callerKind = "agent";
  }
  if (!callerKind && bearer) {
    const { data: userRes } = await admin.auth.getUser(bearer);
    if (userRes?.user) callerKind = "user";
    else {
      const { data: agent } = await admin.from("agents").select("id").eq("enroll_token", bearer).maybeSingle();
      if (agent) callerKind = "agent";
    }
  }
  if (!callerKind) return json({ error: "unauthenticated" }, 401);
  if (callerKind === "agent" && role !== "agent") return json({ error: "role not permitted" }, 403);
  if (callerKind === "user" && role !== "viewer") return json({ error: "role not permitted" }, 403);

  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const token = await signToken({ session, role, exp });

  return json({ token, url: RELAY_WSS_URL, ttl: TTL_SECONDS });
});

async function signToken(payload: { session: string; role: string; exp: number }): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(RELAY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
