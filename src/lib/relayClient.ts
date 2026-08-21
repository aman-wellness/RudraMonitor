/* Dashboard side of the "any network" fallback (WEBRTC_PRODUCTION_SETUP.md §7).
 *
 * When the WebRTC negotiation in remoteControl.ts can't connect — the employee
 * is on a network that blocks the UDP that WebRTC needs — this takes over. It
 * opens a WebSocket to the media relay on 443 (which every network allows),
 * decodes the agent's H.264 stream with WebCodecs, and paints it to a canvas.
 *
 * The canvas is exposed as a MediaStream via captureStream(), so the rest of
 * the UI (the <video srcObject> and all the pointer-mapping math in
 * RemoteStage) works exactly as it does for the WebRTC path — this module is a
 * drop-in transport, not a new render path.
 *
 * Wire format (must match relay.ts and relay_fallback.rs):
 *   binary 0x02 + <SPS><PPS>                        decoder config (Annex-B)
 *   binary 0x01 + <key:u8> + <ts:u64 BE> + <AU>     one H.264 access unit
 *   text   the same control JSON the DataChannel path uses, both directions.
 */
import { supabase } from './supabase';
import type { ControlOut, Phase, SessionHooks } from './remoteControl';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string) ?? '';
const ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? '';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${data.session?.access_token ?? ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Whether this browser can decode H.264 via WebCodecs. If not, the relay
 *  fallback can't render and the caller should report failure rather than hang.
 *  (Chrome/Edge support it, which is what the dashboard targets.) */
export function relayFallbackSupported(): boolean {
  return typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === 'function'
    && typeof (globalThis as { EncodedVideoChunk?: unknown }).EncodedVideoChunk === 'function';
}

// ---- H.264 helpers ---------------------------------------------------------

/** Iterate NAL units in an Annex-B buffer, yielding [offsetOfHeaderByte]. */
function firstNalOfType(buf: Uint8Array, wantType: number): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      const hdr = i + 3;
      if ((buf[hdr] & 0x1f) === wantType) return hdr;
    }
  }
  return -1;
}

/** WebCodecs codec string from the SPS: avc1.<profile><constraints><level>. */
function codecStringFromConfig(spsPps: Uint8Array): string {
  const hdr = firstNalOfType(spsPps, 7); // SPS
  if (hdr >= 0 && hdr + 3 < spsPps.length) {
    const profile = spsPps[hdr + 1];
    const constraints = spsPps[hdr + 2];
    const level = spsPps[hdr + 3];
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
  }
  // High profile / level 4.0 is a safe superset guess if parsing fails.
  return 'avc1.640028';
}

// ---- session ---------------------------------------------------------------

/**
 * Connect the relay fallback for an already-generated `sessionId` (the same id
 * the WebRTC attempt used, so the agent's relay room matches). The caller is
 * expected to have posted `relay_start` for that session already, or to let
 * this do it — see `postRelayStart`.
 */
export function startRelaySession(agentId: string, sessionId: string, hooks: SessionHooks) {
  let ws: WebSocket | null = null;
  let decoder: VideoDecoder | null = null;
  let configured = false;
  let stopped = false;
  let pingTimer: number | null = null;
  const pending = new Map<number, number>();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let stream: MediaStream | null = null;

  const send = (msg: ControlOut) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const phase = (p: Phase, detail?: string) => { if (!stopped) hooks.onPhase(p, detail); };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pingTimer) window.clearInterval(pingTimer);
    try { void postRelayStop(agentId, sessionId); } catch { /* best effort */ }
    try { decoder?.close(); } catch { /* already closed */ }
    try { ws?.close(); } catch { /* already closed */ }
    stream?.getTracks().forEach((t) => t.stop());
    hooks.onPhase('closed');
  };

  const ensureDecoder = (config: Uint8Array) => {
    if (configured) return;
    configured = true;
    decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          ctx?.drawImage(frame, 0, 0);
          if (!stream) {
            // captureStream with no fps captures on each canvas change, so the
            // <video> updates exactly when a new frame decodes.
            stream = canvas.captureStream();
            hooks.onTrack(stream);
            hooks.onScreenInfo?.(canvas.width, canvas.height);
          }
        } finally {
          frame.close();
        }
      },
      error: (e) => phase('failed', `decode error: ${e instanceof Error ? e.message : String(e)}`),
    });
    try {
      decoder.configure({
        codec: codecStringFromConfig(config),
        // Annex-B input (no `description`) + shallow buffering for control latency.
        optimizeForLatency: true,
      });
    } catch (e) {
      phase('failed', `decoder configure failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  (async () => {
    try {
      phase('signalling');
      // Tell the agent to start relaying for this session, then get our token.
      await postRelayStart(agentId, sessionId);
      const { token, url } = await fetchRelayToken(sessionId);

      phase('connecting');
      ws = new WebSocket(`${url}?token=${token}`);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        send({ t: 'hello', proto: 1 });
        pingTimer = window.setInterval(() => {
          const id = Date.now() & 0xffffffff;
          pending.set(id, performance.now());
          send({ t: 'ping', id });
        }, 2000);
      };

      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          let msg: { t: string; w?: number; h?: number; text?: string; id?: number };
          try { msg = JSON.parse(e.data); } catch { return; }
          if (msg.t === 'screen_info') hooks.onScreenInfo?.(msg.w ?? 0, msg.h ?? 0);
          else if (msg.t === 'clip_data') hooks.onClipboard?.(msg.text ?? '');
          else if (msg.t === 'pong' && msg.id !== undefined) {
            const sent = pending.get(msg.id);
            if (sent !== undefined) { pending.delete(msg.id); hooks.onLatency?.(Math.round(performance.now() - sent)); }
          } else if (msg.t === 'relay_hello') {
            phase('connected'); // socket up; frames follow once the agent encodes
          }
          return;
        }
        // Binary — a media or config frame.
        const buf = new Uint8Array(e.data as ArrayBuffer);
        if (buf.length < 1) return;
        const tag = buf[0];
        if (tag === 0x02) {
          ensureDecoder(buf.subarray(1));
          return;
        }
        if (tag === 0x01) {
          if (buf.length < 10) return;
          const keyframe = buf[1] === 1;
          const view = new DataView(e.data as ArrayBuffer);
          const ts = Number(view.getBigUint64(2));
          const payload = buf.subarray(10);
          if (!configured) {
            // A keyframe carries SPS+PPS prepended, so it can configure us too.
            if (keyframe) ensureDecoder(payload);
            else return; // wait for a keyframe before decoding deltas
          }
          if (!decoder || decoder.state !== 'configured') return;
          // The decoder needs a keyframe first; drop deltas until one arrives.
          if (!keyframe && (decoder as VideoDecoder & { _gotKey?: boolean })._gotKey !== true) return;
          if (keyframe) (decoder as VideoDecoder & { _gotKey?: boolean })._gotKey = true;
          try {
            decoder.decode(new EncodedVideoChunk({
              type: keyframe ? 'key' : 'delta',
              timestamp: ts,
              data: payload,
            }));
            if (!stream) phase('connected');
          } catch { /* transient decode hiccup; next keyframe re-syncs */ }
        }
      };

      ws.onerror = () => phase('failed', 'relay socket error');
      ws.onclose = () => { if (!stopped) hooks.onPhase('closed'); };
    } catch (e) {
      phase('failed', e instanceof Error ? e.message : String(e));
    }
  })();

  return {
    sessionId,
    stop,
    send,
    sendPointer(el: HTMLVideoElement, clientX: number, clientY: number) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const vw = el.videoWidth || r.width;
      const vh = el.videoHeight || r.height;
      const scale = Math.min(r.width / vw, r.height / vh);
      const drawnW = vw * scale;
      const drawnH = vh * scale;
      const offX = (r.width - drawnW) / 2;
      const offY = (r.height - drawnH) / 2;
      const x = (clientX - r.left - offX) / drawnW;
      const y = (clientY - r.top - offY) / drawnH;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      send({ t: 'mouse_move', x, y });
    },
  };
}

export type RelaySession = ReturnType<typeof startRelaySession>;

async function fetchRelayToken(sessionId: string): Promise<{ token: string; url: string }> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/webrtc-relay-token`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ session: sessionId, role: 'viewer' }),
  });
  if (!resp.ok) throw new Error(`relay token ${resp.status}: ${await resp.text().catch(() => '')}`);
  const body = await resp.json() as { token?: string; url?: string };
  if (!body.token || !body.url) throw new Error('relay token response incomplete');
  return { token: body.token, url: body.url };
}

async function postRelaySignal(agentId: string, sessionId: string, kind: 'relay_start' | 'relay_stop') {
  await fetch(`${SUPABASE_URL}/functions/v1/webrtc-signal`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ session_id: sessionId, agent_id: agentId, direction: 'to_agent', kind, payload: {} }),
  });
}
export const postRelayStart = (agentId: string, sessionId: string) => postRelaySignal(agentId, sessionId, 'relay_start');
export const postRelayStop = (agentId: string, sessionId: string) => postRelaySignal(agentId, sessionId, 'relay_stop');
