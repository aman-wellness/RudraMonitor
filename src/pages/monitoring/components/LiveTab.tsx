import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgents } from '@/lib/dataHooks';
import { supabase } from '@/lib/supabase';

// Dashboard side of the live-monitoring WebRTC stream.
//
// Workflow when the user picks an agent:
//   1. Fetch fresh TURN credentials from /webrtc-turn-credentials and
//      build an RTCPeerConnection with the returned iceServers.
//   2. addTransceiver('video', { direction: 'recvonly' }) so the SDP
//      offer asks the agent to send us a video track.
//   3. Create offer → setLocalDescription → POST offer to
//      /webrtc-signal (direction=to_agent, kind=offer). session_id is
//      a fresh UUID owned by this browser tab.
//   4. Long-poll /webrtc-signal direction=to_dashboard for the agent's
//      answer + ICE candidates. Drive ICE in parallel both directions.
//   5. ontrack fires when the remote MediaStreamTrack arrives — attach
//      to the <video> element and play.
//   6. On unmount / agent change / "Stop" click, close the peer and
//      stop the long-poll.

interface SignalEnvelope {
  id: string;
  kind: 'offer' | 'answer' | 'ice_candidate';
  payload: Record<string, unknown>;
  created_at: string;
  session_id?: string | null;
}

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string) || 'https://api.rudrans.com';
const ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || '';

export default function LiveTab() {
  const { agents } = useAgents();
  const onlineAgents = useMemo(() => agents.filter((a) => a.status !== 'offline'), [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'failed'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Live WebRTC stats — surfaces packet/byte/frame counters so we can
  // tell the difference between "no RTP arriving" (agent encoder dead)
  // vs "RTP arriving but won't decode" (codec / SPS-PPS / bsf issue).
  // Without this we just see a black box and have to guess.
  const [stats, setStats] = useState<{
    bytes: number; packets: number; framesDecoded: number; framesDropped: number;
    fps: number; width: number; height: number; nack: number; pli: number;
    iceState: string; dtlsState: string;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const stopFlag = useRef(false);
  const sessionIdRef = useRef<string | null>(null);

  // Tear everything down whenever the selected agent changes.
  useEffect(() => {
    stopFlag.current = false;
    if (!selectedId) return;
    void startStream(selectedId);
    return () => {
      stopFlag.current = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const teardown = () => {
    if (pcRef.current) {
      try { pcRef.current.close(); } catch { /* ignore */ }
      pcRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    sessionIdRef.current = null;
    setStatus('idle');
  };

  const startStream = async (agentId: string) => {
    setStatus('connecting');
    setErrorMsg(null);
    const sessionId = crypto.randomUUID();
    sessionIdRef.current = sessionId;

    try {
      const session = (await supabase.auth.getSession()).data.session;
      const jwt = session?.access_token;
      if (!jwt) throw new Error('Not signed in');

      // 1. TURN credentials
      const credsResp = await fetch(`${SUPABASE_URL}/functions/v1/webrtc-turn-credentials`, {
        method: 'POST',
        headers: {
          'apikey': ANON_KEY,
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
      });
      if (!credsResp.ok) {
        throw new Error(`turn credentials: ${credsResp.status} ${await credsResp.text()}`);
      }
      const credsBody = (await credsResp.json()) as { iceServers: RTCIceServer[] };

      // 2. Build peer connection
      const pc = new RTCPeerConnection({ iceServers: credsBody.iceServers });
      pcRef.current = pc;

      pc.ontrack = (ev) => {
        if (videoRef.current && ev.streams[0]) {
          videoRef.current.srcObject = ev.streams[0];
          videoRef.current.play().catch(() => { /* user gesture not required for muted */ });
        }
      };
      pc.oniceconnectionstatechange = () => {
        console.log('[LiveTab] iceConnectionState →', pc.iceConnectionState);
        if (stopFlag.current) return;
        const s = pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') setStatus('live');
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          setStatus('failed');
          setErrorMsg(`Peer connection ${s}`);
        }
      };
      pc.onicegatheringstatechange = () => {
        console.log('[LiveTab] iceGatheringState →', pc.iceGatheringState);
      };
      pc.onicecandidateerror = (ev) => {
        const e = ev as RTCPeerConnectionIceErrorEvent;
        console.warn('[LiveTab] icecandidate error', {
          address: e.address,
          port: e.port,
          url: e.url,
          errorCode: e.errorCode,
          errorText: e.errorText,
        });
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          console.log('[LiveTab] local candidate', ev.candidate.candidate);
          void postSignal(jwt, sessionId, agentId, 'to_agent', 'ice_candidate', ev.candidate.toJSON());
        } else {
          console.log('[LiveTab] local ICE gathering complete (null candidate)');
        }
      };

      // 3. recvonly video transceiver — we don't send anything, just receive.
      pc.addTransceiver('video', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 4. POST the offer — first munge it so it only advertises Constrained
      //    Baseline H.264 PTs. Without this, webrtc-rs on the agent picks
      //    High Profile (PT 119 in Chrome's offer), but our ffmpeg encoder
      //    only emits Constrained Baseline — Chrome's H.264 decoder then
      //    silently refuses every frame (Live pill green, screen black,
      //    framesDecoded stays at 0). Restricting the offer to baseline
      //    PTs forces the agent's answer to also be baseline, and the
      //    bitstream profile now matches the negotiated profile.
      const baselineSdp = forceBaselineH264(offer.sdp ?? '');
      await postSignal(jwt, sessionId, agentId, 'to_agent', 'offer', { sdp: baselineSdp });

      // 5. Long-poll for answer + remote ICE candidates in the background
      void pollLoop(jwt, sessionId, pc);
      // 6. Stats poll — 1Hz. Stops automatically once stopFlag flips
      //    or sessionId is rotated out.
      void statsLoop(pc, sessionId);
    } catch (e) {
      console.error('live stream start failed', e);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('failed');
      teardown();
    }
  };

  const statsLoop = async (pc: RTCPeerConnection, sessionId: string) => {
    let prevBytes = 0;
    let prevFrames = 0;
    let prevTs = Date.now();
    while (!stopFlag.current && sessionIdRef.current === sessionId && pc.connectionState !== 'closed') {
      try {
        const report = await pc.getStats();
        let inb: RTCInboundRtpStreamStats | null = null;
        report.forEach((s: { type: string; kind?: string }) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s as RTCInboundRtpStreamStats;
        });
        if (inb) {
          const i = inb as RTCInboundRtpStreamStats & {
            framesDecoded?: number; framesDropped?: number; frameWidth?: number; frameHeight?: number;
            nackCount?: number; pliCount?: number;
          };
          const now = Date.now();
          const dt = (now - prevTs) / 1000;
          const bytes = (i.bytesReceived as number) ?? 0;
          const framesDecoded = i.framesDecoded ?? 0;
          const fps = dt > 0 ? Math.round((framesDecoded - prevFrames) / dt) : 0;
          setStats({
            bytes,
            packets: (i.packetsReceived as number) ?? 0,
            framesDecoded,
            framesDropped: i.framesDropped ?? 0,
            fps,
            width: i.frameWidth ?? 0,
            height: i.frameHeight ?? 0,
            nack: i.nackCount ?? 0,
            pli: i.pliCount ?? 0,
            iceState: pc.iceConnectionState,
            dtlsState: pc.connectionState,
          });
          prevBytes = bytes; prevFrames = framesDecoded; prevTs = now;
        }
      } catch (e) {
        console.warn('[LiveTab] stats poll failed', e);
      }
      void prevBytes;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };

  const pollLoop = async (jwt: string, sessionId: string, pc: RTCPeerConnection) => {
    let since = new Date(Date.now() - 5000).toISOString(); // include slight pre-history just in case
    while (!stopFlag.current && sessionIdRef.current === sessionId) {
      try {
        const url = new URL(`${SUPABASE_URL}/functions/v1/webrtc-signal`);
        url.searchParams.set('session_id', sessionId);
        url.searchParams.set('direction', 'to_dashboard');
        url.searchParams.set('since', since);
        const resp = await fetch(url.toString(), {
          headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${jwt}` },
        });
        if (!resp.ok) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        const body = (await resp.json()) as { messages: SignalEnvelope[] };
        for (const msg of body.messages) {
          since = msg.created_at;
          if (msg.kind === 'answer' && typeof msg.payload.sdp === 'string') {
            await pc.setRemoteDescription({ type: 'answer', sdp: msg.payload.sdp });
          } else if (msg.kind === 'ice_candidate') {
            try {
              await pc.addIceCandidate(msg.payload as RTCIceCandidateInit);
            } catch (e) {
              console.warn('addIceCandidate failed', e);
            }
          }
        }
      } catch (e) {
        console.warn('pollLoop error', e);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            disabled={onlineAgents.length === 0}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">
              {onlineAgents.length === 0 ? 'No online agents' : 'Select agent…'}
            </option>
            {onlineAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.machine})</option>
            ))}
          </select>
          {selectedId && (
            <button
              onClick={() => { stopFlag.current = true; setSelectedId(null); teardown(); }}
              className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-xs font-medium"
            >
              Stop
            </button>
          )}
        </div>
        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${
          status === 'live' ? 'bg-emerald-500/15 text-emerald-300'
          : status === 'connecting' ? 'bg-amber-500/15 text-amber-300'
          : status === 'failed' ? 'bg-red-500/15 text-red-300'
          : 'bg-dark-800 text-gray-400'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${
            status === 'live' ? 'bg-emerald-400 animate-pulse'
            : status === 'connecting' ? 'bg-amber-400 animate-pulse'
            : status === 'failed' ? 'bg-red-400'
            : 'bg-gray-500'
          }`} />
          {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : status === 'failed' ? (errorMsg ?? 'Failed') : 'Idle'}
        </span>
      </div>

      <div className="aspect-video bg-dark-900 border border-dark-700 rounded-xl overflow-hidden relative">
        {selectedId ? (
          <>
            <video
              ref={videoRef}
              className="w-full h-full object-contain bg-black"
              autoPlay
              playsInline
              muted
            />
            {stats && (
              <div className="absolute top-2 right-2 bg-black/70 text-[10px] font-mono text-emerald-300 px-2 py-1.5 rounded leading-tight space-y-0.5 pointer-events-none">
                <div>ice: <span className="text-white">{stats.iceState}</span> · dtls: <span className="text-white">{stats.dtlsState}</span></div>
                <div>bytes: <span className="text-white">{stats.bytes.toLocaleString()}</span> · pkts: <span className="text-white">{stats.packets}</span></div>
                <div>fps: <span className="text-white">{stats.fps}</span> · {stats.width}×{stats.height}</div>
                <div>decoded: <span className="text-white">{stats.framesDecoded}</span> · dropped: <span className={stats.framesDropped > 0 ? 'text-amber-300' : 'text-white'}>{stats.framesDropped}</span></div>
                <div>nack: <span className="text-white">{stats.nack}</span> · pli: <span className="text-white">{stats.pli}</span></div>
              </div>
            )}
            {stats && stats.bytes === 0 && status === 'live' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center bg-black/60 px-4 py-3 rounded-lg">
                  <p className="text-sm text-amber-300">No video bytes yet</p>
                  <p className="text-[11px] text-gray-400 mt-1">ICE is up but the agent isn't sending RTP — encoder may not have started.</p>
                </div>
              </div>
            )}
            {stats && stats.bytes > 0 && stats.framesDecoded === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center bg-black/60 px-4 py-3 rounded-lg">
                  <p className="text-sm text-rose-300">RTP arriving but decoder stalled</p>
                  <p className="text-[11px] text-gray-400 mt-1">{stats.bytes.toLocaleString()} bytes received, 0 frames decoded — likely codec / SPS-PPS mismatch.</p>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
                <i className="ri-broadcast-line text-3xl" />
              </span>
              <p className="text-sm text-gray-400">Select an online agent above to start a live stream.</p>
              <p className="text-[11px] text-gray-600 mt-1">Requires the agent on v0.2.27+ with Screen Recording permission granted.</p>
            </div>
          </div>
        )}
      </div>
      {selectedId && stats && (
        <p className="text-[11px] text-gray-500">
          Diagnostics: bytes={stats.bytes.toLocaleString()} pkts={stats.packets} fps={stats.fps} decoded={stats.framesDecoded} dropped={stats.framesDropped} {stats.width}×{stats.height} · share these numbers if the screen stays black.
        </p>
      )}

      {status === 'failed' && errorMsg && (
        <p className="text-xs text-red-400">Error: {errorMsg}</p>
      )}
    </div>
  );
}

async function postSignal(
  jwt: string,
  sessionId: string,
  agentId: string,
  direction: 'to_agent' | 'to_dashboard',
  kind: 'offer' | 'answer' | 'ice_candidate',
  payload: unknown,
) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/webrtc-signal`, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session_id: sessionId,
      agent_id: agentId,
      direction,
      kind,
      payload,
    }),
  });
  if (!resp.ok) {
    console.warn('postSignal failed', resp.status, await resp.text());
  }
}

// Strip non-baseline H.264 codecs from the SDP m=video line and remove
// their associated a=rtpmap / a=fmtp / a=rtcp-fb lines. The agent's
// ffmpeg encoder is hard-pinned to Constrained Baseline (profile_idc=66)
// for hw-encoder compatibility, so we cannot let the agent's answer pick
// PT 119 (High) etc. — Chrome's H.264 decoder rejects mid-stream when
// negotiated profile-level-id and SPS profile_idc disagree.
//
// "Baseline-compatible" = profile-level-id starts with 42 (Constrained
// Baseline) or 4d (Main, which is a superset that still decodes our
// baseline bitstream without complaints in every browser we've tested).
// Everything else — 64 (High), 6e (High 10), f4 (High 4:4:4), etc. —
// gets stripped from the m-line and all matching attribute lines.
export function forceBaselineH264(sdp: string): string {
  if (!sdp) return sdp;
  // Find each video m-line's H.264 PTs and check their fmtp profile-level-id.
  // PTs we want to keep are those with no profile-level-id (legacy) OR
  // with one starting in 42 / 4d.
  const lines = sdp.split(/\r?\n/);
  const fmtpById = new Map<string, string>();
  const rtpmapH264 = new Set<string>();
  for (const ln of lines) {
    const rm = ln.match(/^a=rtpmap:(\d+)\s+H264\/90000/i);
    if (rm) rtpmapH264.add(rm[1]);
    const fm = ln.match(/^a=fmtp:(\d+)\s+(.+)$/);
    if (fm) fmtpById.set(fm[1], fm[2]);
  }
  // Decide which H.264 PTs to DROP.
  const drop = new Set<string>();
  for (const pt of rtpmapH264) {
    const fmtp = fmtpById.get(pt) ?? '';
    const m = fmtp.match(/profile-level-id=([0-9a-fA-F]{6})/);
    if (!m) continue; // no profile = keep
    const prof = m[1].slice(0, 2).toLowerCase();
    if (prof !== '42' && prof !== '4d') drop.add(pt);
  }
  if (drop.size === 0) return sdp;
  const out: string[] = [];
  for (const ln of lines) {
    // Rewrite m=video by removing dropped PTs from the payload list.
    if (ln.startsWith('m=video ')) {
      const parts = ln.split(' ');
      const head = parts.slice(0, 3);
      const pts = parts.slice(3).filter((p) => !drop.has(p));
      out.push([...head, ...pts].join(' '));
      continue;
    }
    // Drop a=rtpmap / a=fmtp / a=rtcp-fb / a=rtpmap apt= lines that
    // reference a dropped PT. Also drop apt= chained codecs (RED / RTX)
    // whose `apt=<pt>` points at a dropped PT.
    const ptMatch = ln.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)\b/);
    if (ptMatch && drop.has(ptMatch[1])) continue;
    const aptMatch = ln.match(/^a=fmtp:(\d+)\s+apt=(\d+)/);
    if (aptMatch && drop.has(aptMatch[2])) {
      drop.add(aptMatch[1]); // also drop the RTX/RED that depended on it
      continue;
    }
    out.push(ln);
  }
  return out.join('\r\n');
}
