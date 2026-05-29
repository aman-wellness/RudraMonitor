// Dashboard-side LiveKit bridge.
//
// One source of truth for:
//   • mintToken()    — fetch a per-room JWT from /functions/v1/livekit-token
//   • signalStart()  — kick the agent so it publishes (writes a
//                      kind='livekit_start' row into webrtc_signaling)
//   • signalStop()   — tell the agent to drop the publish session
//   • connectToAgent() — opens a Room subscription, returns the Room
//                        plus an unsubscribe / leave helper
//
// Live and Remote tabs both call connectToAgent(). The DIFFERENCE is
// that Remote also opens a "control" DataChannel on the agent's
// LocalParticipant publication for mouse/keyboard input — that's done
// via room.localParticipant.publishData() so livekit-client handles the
// SDP / reliability negotiation for us.
//
// Why a tiny helper layer instead of inlining livekit-client calls in
// each Tab? Three reasons: the start/stop signaling is identical for
// both tabs, the error-handling path (token expiry, room reconnect,
// agent went offline) is non-trivial and worth centralising, and Block
// G of the LiveKit pivot will delete the legacy webrtc-signal POSTs
// from EVERY caller — having them in one file makes that grep-and-go.

import {
  Room,
  RoomEvent,
  RemoteTrack,
  RemoteParticipant,
  ConnectionState,
} from 'livekit-client';
import { supabase } from './supabase';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string) ?? '';
const ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? '';

export interface LiveKitTokenResponse {
  url: string;       // wss URL the SDK connects to
  token: string;     // signed JWT
  room: string;      // resolved room name (= agent_<id>)
  identity: string;  // "user-<uid>"
  expires_in: number;
}

export async function mintToken(agentId: string): Promise<LiveKitTokenResponse> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('not signed in');
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/livekit-token`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`livekit-token ${resp.status}: ${body}`);
  }
  return (await resp.json()) as LiveKitTokenResponse;
}

/// Post one signaling row to /functions/v1/webrtc-signal. The agent's
/// whip_publisher long-polls this table for kind='livekit_start' and
/// kind='livekit_stop'. Backend doesn't validate `kind` against an enum
/// so we can use these names without a migration.
async function postSignal(
  agentId: string,
  sessionId: string,
  kind: 'livekit_start' | 'livekit_stop',
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('not signed in');
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/webrtc-signal`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session_id: sessionId,
      agent_id: agentId,
      direction: 'to_agent',
      kind,
      payload,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`signal ${kind} ${resp.status}: ${body}`);
  }
}

export const signalStart = (agentId: string, sessionId: string, room?: string) =>
  postSignal(agentId, sessionId, 'livekit_start', room ? { room } : {});

export const signalStop = (agentId: string, sessionId: string) =>
  postSignal(agentId, sessionId, 'livekit_stop');

export interface AgentRoomHandle {
  room: Room;
  /// Resolves once the agent's first video track is subscribed. Useful
  /// for the Tab's "Connecting…" → "Live" transition.
  firstVideoTrack: Promise<RemoteTrack>;
  /// Tear everything down. Idempotent.
  leave: () => Promise<void>;
}

export interface ConnectOptions {
  agentId: string;
  /// Per-tab session id — used in the start/stop signal envelope so the
  /// agent can correlate. We generate one per `connectToAgent` call.
  sessionId: string;
  /// Fires whenever a track is subscribed (video or data-channel).
  onTrack?: (track: RemoteTrack, participant: RemoteParticipant) => void;
  /// Fires on connection state transitions (Connecting → Connected →
  /// Reconnecting → Disconnected). LiveKit reconnects automatically on
  /// network blips; the callback is purely for UI labelling.
  onConnectionState?: (state: ConnectionState) => void;
  /// Fires when LiveKit's Room emits an error. Don't tear down — Room
  /// usually retries internally. We surface it so the Tab can show a
  /// banner.
  onError?: (err: Error) => void;
}

export async function connectToAgent(opts: ConnectOptions): Promise<AgentRoomHandle> {
  const { agentId, sessionId, onTrack, onConnectionState, onError } = opts;

  // 1) Get a JWT for the agent's room.
  const tok = await mintToken(agentId);

  // 2) Build a Room. adaptiveStream + dynacast keep CPU + bandwidth
  //    sensible when the operator has multiple Live tabs open.
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    // Disable the SDK's resume-on-tab-hidden behaviour — for monitoring
    // dashboards, leaving the tab in the background AND watching is a
    // valid use case (admin wants Live up while doing other work).
    disconnectOnPageLeave: false,
  });

  let firstVideoResolve!: (t: RemoteTrack) => void;
  let firstVideoReject!: (e: Error) => void;
  const firstVideoTrack = new Promise<RemoteTrack>((res, rej) => {
    firstVideoResolve = res;
    firstVideoReject = rej;
  });

  room
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === 'video') {
        // First video track wins. Same-named participant republishing
        // (reconnect / quality change) re-fires this — the consumer
        // attaches to a fresh <video> element each time, so we don't
        // resolve again.
        try { firstVideoResolve(track); } catch { /* already resolved */ }
      }
      onTrack?.(track, participant);
    })
    .on(RoomEvent.ConnectionStateChanged, (state) => {
      onConnectionState?.(state);
    })
    .on(RoomEvent.Disconnected, (reason) => {
      onConnectionState?.(ConnectionState.Disconnected);
      // If we never saw a video track, surface that as an error so the
      // Tab can show "agent didn't publish".
      firstVideoReject(new Error(`disconnected: ${reason ?? 'unknown'}`));
    });

  // 3) Tell the agent to start publishing. We do this BEFORE connect()
  //    so the agent has time to fire up ffmpeg + the WHIP session in
  //    parallel with us joining the room. Latency reduction: agents
  //    typically take ~1 s to publish their first video frame, dashboard
  //    connect is ~300 ms — running them in parallel keeps total "click
  //    to first frame" under 2 s on a warm path.
  try {
    await signalStart(agentId, sessionId);
  } catch (e) {
    // Surface as error and continue — the agent might already be
    // publishing (concurrent admin watching). Connect anyway; if the
    // room has no publisher, firstVideoTrack will reject after ~10s.
    onError?.(e instanceof Error ? e : new Error(String(e)));
  }

  // 4) Connect. autoSubscribe defaults to true — we get the agent's
  //    video as soon as it's published.
  await room.connect(tok.url, tok.token, { autoSubscribe: true });

  // 5) Build the teardown helper. Idempotent (LiveKit's disconnect is
  //    a no-op if already disconnected).
  let torn = false;
  const leave = async () => {
    if (torn) return;
    torn = true;
    try { await signalStop(agentId, sessionId); } catch { /* best effort */ }
    try { await room.disconnect(true); } catch { /* best effort */ }
  };

  return { room, firstVideoTrack, leave };
}

/// Publish JSON-encoded control events on the room's local participant.
/// Used by RemoteTab for mouse + keyboard injection. LiveKit auto-
/// chunks and reliably-delivers data messages — no manual chunking or
/// retries needed on our side.
export async function sendControl(room: Room, payload: unknown): Promise<void> {
  const enc = new TextEncoder();
  await room.localParticipant.publishData(
    enc.encode(JSON.stringify(payload)),
    { reliable: true, topic: 'control' },
  );
}
