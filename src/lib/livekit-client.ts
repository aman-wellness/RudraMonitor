// Thin LiveKit helper: mint a JWT via our livekit-token edge fn and
// open a Room connection for a given agent. Used by LiveTab / RemoteTab.
//
// Replaces the hand-rolled signaling + RTCPeerConnection setup that
// lived in RemoteTab.tsx (and a lighter version in LiveTab.tsx). All the
// ICE / TURN / SDP / jitter-buffer choreography is now LiveKit's job —
// here we only authenticate and hand the SDK a token + URL.

import {
  Room,
  RoomEvent,
  RemoteTrack,
  RemoteParticipant,
  TrackEvent,
  ConnectionState,
} from 'livekit-client';
import { supabase } from './supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface RoomHandle {
  room: Room;
  /** Disconnect + free resources. Always safe to call multiple times. */
  close: () => Promise<void>;
}

/** POST /functions/v1/livekit-token to mint a JWT for joining this
 *  agent's room. Throws on 4xx / 5xx so callers can surface a real
 *  error to the operator instead of staring at a black rectangle. */
export async function mintToken(agentId: string): Promise<{ url: string; token: string; room: string }> {
  const session = (await supabase.auth.getSession()).data.session;
  const jwt = session?.access_token;
  if (!jwt) throw new Error('Not signed in');

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/livekit-token`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agent_id: agentId }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`livekit-token ${resp.status}: ${txt}`);
  }
  return resp.json() as Promise<{ url: string; token: string; room: string }>;
}

/** Connect to the agent's LiveKit room and attach handlers. Caller is
 *  responsible for calling handle.close() when the component unmounts. */
export async function connectToAgent(opts: {
  agentId: string;
  onVideoTrack: (track: RemoteTrack, participant: RemoteParticipant) => void;
  onData?: (text: string) => void;
  onState?: (state: ConnectionState) => void;
}): Promise<RoomHandle> {
  const { url, token } = await mintToken(opts.agentId);

  // Default RoomOptions ship with adaptive simulcast + DTX + audio
  // processing. We disable adaptive stream for now — the desktop is a
  // single producer, not a multi-track conference — and rely on the
  // SFU's automatic bandwidth handling.
  const room = new Room({
    adaptiveStream: false,
    dynacast: true,
    publishDefaults: { videoSimulcastLayers: [] },
  });

  // Hook handlers BEFORE connect so the first `Connected` / `TrackSubscribed`
  // events aren't missed during the brief negotiation window.
  room.on(RoomEvent.ConnectionStateChanged, (state) => {
    opts.onState?.(state);
  });
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind === 'video') {
      // Hint the receiver to use the smallest possible jitter buffer.
      // Critical for remote-desktop feel; without it the cursor lags
      // by 100-200 ms.
      try {
        (track as RemoteTrack & { mediaStreamTrack: MediaStreamTrack & { playoutDelayHint?: number } })
          .mediaStreamTrack.playoutDelayHint = 0;
      } catch { /* not Chromium — ignore */ }
      opts.onVideoTrack(track, participant);
    }
  });
  room.on(RoomEvent.DataReceived, (payload) => {
    if (!opts.onData) return;
    const text = new TextDecoder().decode(payload);
    opts.onData(text);
  });
  room.prepareConnection?.(url, token);

  await room.connect(url, token);

  return {
    room,
    close: async () => {
      try { await room.disconnect(); } catch { /* idempotent */ }
    },
  };
}

/** Send a JSON control message to the agent over the lossless data channel.
 *  Used for mouse / keyboard / clipboard signals from RemoteTab. */
export async function sendControl(room: Room, obj: Record<string, unknown>): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  await room.localParticipant.publishData(payload, { reliable: true });
}

export type { Room, RemoteTrack, RemoteParticipant };
export { ConnectionState, TrackEvent };
