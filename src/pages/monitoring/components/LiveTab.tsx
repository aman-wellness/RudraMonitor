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

      // 4. POST the offer
      await postSignal(jwt, sessionId, agentId, 'to_agent', 'offer', { sdp: offer.sdp });

      // 5. Long-poll for answer + remote ICE candidates in the background
      void pollLoop(jwt, sessionId, pc);
    } catch (e) {
      console.error('live stream start failed', e);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('failed');
      teardown();
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
          <video
            ref={videoRef}
            className="w-full h-full object-contain bg-black"
            autoPlay
            playsInline
            muted
          />
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
