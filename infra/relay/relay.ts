// Rudrans media relay — the "works on any network" fallback path.
//
// WHY THIS EXISTS
//
// Live View and Remote normally run over WebRTC (direct, or via the TURN
// relay). That covers every network that lets outbound UDP through — all
// normal home and mobile connections. It does NOT cover an employee on a
// network that blocks UDP entirely (strict corporate LANs, some hotels, a few
// national ISPs), because the agent's WebRTC stack (webrtc-rs) can only send
// media over UDP.
//
// This relay is the fallback for exactly that case. Both the agent and the
// dashboard open an OUTBOUND WebSocket to it on 443. Outbound 443 (TLS) is
// allowed on essentially every network on earth — to any firewall it looks
// like an ordinary HTTPS connection — so if this can't be reached, nothing
// can. The relay just forwards bytes between the two peers of a session; it
// never inspects or stores media.
//
// WHAT IT IS NOT
//
// Not an SFU, not a decoder, not a recorder. One session = one agent + one
// viewer. It forwards the agent's H.264 stream to the viewer, and the viewer's
// control messages (mouse/keyboard/clipboard) to the agent. Nothing else.
//
// DEPLOY
//
//   Behind TLS on 443. Two ways:
//     • Terminate TLS at a reverse proxy (Caddy/nginx) → proxy_pass to this on
//       an internal port. Easiest; the proxy owns the cert.
//     • Or run this with Deno.serve({ cert, key }) directly on 443.
//   It must share RELAY_SECRET with the `webrtc-relay-token` edge function,
//   which mints the short-lived per-session tokens clients present here.
//
//   deno run --allow-net --allow-env relay.ts
//
// SCALE / GEO
//
//   Stateless except for the in-memory room map, so you can run one per region
//   and route clients to the nearest (the token carries the relay host). For a
//   single global instance, latency is one hop through wherever it lives — fine
//   to start; see WEBRTC_PRODUCTION_SETUP.md §6.

const PORT = Number(Deno.env.get("RELAY_PORT") ?? "8443");
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") ?? "";
if (!RELAY_SECRET) {
  console.error("RELAY_SECRET not set — refusing to start (tokens can't be verified)");
  Deno.exit(1);
}

// ---- session token verification -------------------------------------------
//
// The token is minted by the `webrtc-relay-token` edge function after it has
// authenticated the caller (agent enroll_token or dashboard user JWT). It is a
// compact HMAC-signed blob: base64url(JSON) + "." + base64url(HMAC-SHA256).
// The relay only trusts RELAY_SECRET, so it needs no database and stays fast.
//
// Payload: { session: string, role: "agent"|"viewer", exp: number(seconds) }

interface TokenPayload { session: string; role: "agent" | "viewer"; exp: number }

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyToken(token: string): Promise<TokenPayload | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(RELAY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(sig),
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as TokenPayload;
    // Date.now is fine here — this is a server, not a replayable workflow.
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    if (payload.role !== "agent" && payload.role !== "viewer") return null;
    if (!payload.session) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- rooms -----------------------------------------------------------------

interface Peer { ws: WebSocket; role: "agent" | "viewer" }
interface Room { agent?: Peer; viewer?: Peer }
const rooms = new Map<string, Room>();

// Media backpressure threshold. If the receiver's send buffer is above this,
// drop DELTA video frames (never config or keyframes) so latency doesn't grow
// unboundedly on a slow link. 2 MB ~= a fraction of a second of 1080p video.
const BACKPRESSURE_BYTES = 2 * 1024 * 1024;

// Binary frame tags (byte 0). The relay only needs to tell "droppable delta
// video" from "must-deliver" — it does not otherwise parse the payload.
const TAG_MEDIA = 0x01;    // byte 1: 1 = keyframe (never drop), 0 = delta
const TAG_CONFIG = 0x02;   // SPS/PPS / decoder config — never drop

function forward(from: Peer, to: Peer | undefined, data: string | ArrayBuffer) {
  if (!to || to.ws.readyState !== WebSocket.OPEN) return;

  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    const tag = bytes[0];
    const isDroppable = tag === TAG_MEDIA && bytes[1] === 0;
    if (isDroppable && to.ws.bufferedAmount > BACKPRESSURE_BYTES) {
      // Receiver is behind — skip this delta frame. The next keyframe re-syncs
      // the decoder, so dropping deltas degrades smoothly instead of stalling.
      return;
    }
  }
  try {
    to.ws.send(data);
  } catch {
    /* peer went away between the readyState check and send; ignore */
  }
}

function handleSocket(ws: WebSocket, tok: TokenPayload) {
  const peer: Peer = { ws, role: tok.role };
  let room = rooms.get(tok.session);
  if (!room) { room = {}; rooms.set(tok.session, room); }

  // One occupant per role. A reconnecting client replaces the stale socket.
  const existing = room[tok.role];
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    try { existing.ws.close(4001, "replaced by newer connection"); } catch { /* */ }
  }
  room[tok.role] = peer;

  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    // Tell each side whether its counterpart is present, so the sender can
    // hold off pushing video until a viewer is actually attached.
    const other = tok.role === "agent" ? room!.viewer : room!.agent;
    ws.send(JSON.stringify({ t: "relay_hello", peer_present: !!other }));
    if (other && other.ws.readyState === WebSocket.OPEN) {
      other.ws.send(JSON.stringify({ t: "peer_joined", role: tok.role }));
    }
  };

  ws.onmessage = (ev) => {
    const r = rooms.get(tok.session);
    if (!r) return;
    const dest = tok.role === "agent" ? r.viewer : r.agent;
    forward(peer, dest, ev.data);
  };

  const cleanup = () => {
    const r = rooms.get(tok.session);
    if (!r) return;
    if (r[tok.role] === peer) r[tok.role] = undefined;
    const other = tok.role === "agent" ? r.viewer : r.agent;
    if (other && other.ws.readyState === WebSocket.OPEN) {
      try { other.ws.send(JSON.stringify({ t: "peer_left", role: tok.role })); } catch { /* */ }
    }
    if (!r.agent && !r.viewer) rooms.delete(tok.session);
  };
  ws.onclose = cleanup;
  ws.onerror = cleanup;
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/healthz") {
    return new Response(JSON.stringify({ ok: true, rooms: rooms.size }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }

  const token = url.searchParams.get("token") ?? "";
  const payload = await verifyToken(token);
  if (!payload) return new Response("unauthorized", { status: 401 });

  const { socket, response } = Deno.upgradeWebSocket(req);
  handleSocket(socket, payload);
  return response;
});

console.log(`relay listening on :${PORT} (path /ws) — put TLS/443 in front of it`);
