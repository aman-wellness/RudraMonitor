import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgents } from '@/lib/dataHooks';
import { supabase } from '@/lib/supabase';

// Remote Desktop tab. Same WebRTC peer-connection plumbing as LiveTab, but
// also negotiates a bidirectional data channel (label="control") used for
// mouse/keyboard injection + clipboard sync. The video track flows
// identically to Live (agent → dashboard, recvonly from our POV).
//
// Workflow when the user picks an agent:
//   1. Fetch fresh TURN credentials from /webrtc-turn-credentials.
//   2. Build RTCPeerConnection. Create data channel "control" BEFORE the
//      offer so the SDP contains an m=application section — that's what
//      the edge function uses to mint a remote_sessions audit row, and
//      what the agent uses to know "this is a Remote session, not Live".
//   3. addTransceiver('video', recvonly) for the screen.
//   4. createOffer / setLocalDescription / POST offer / poll for answer
//      + remote ICE, identical to LiveTab.
//   5. Once the DC is open, the "Take Control" button unlocks. Clicking
//      it requests pointer lock on the video element and starts capturing
//      mouse + keyboard events into JSON messages on the DC.
//   6. Clipboard: pasting into the video sends `clip_set`; pressing Cmd/
//      Ctrl+C on the video requests the agent's clipboard via `clip_get`
//      and writes the reply into the local clipboard.

interface SignalEnvelope {
  id: string;
  kind: 'offer' | 'answer' | 'ice_candidate';
  payload: Record<string, unknown>;
  created_at: string;
  session_id?: string | null;
}

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string) || 'https://api.rudrans.com';
const ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || '';

export default function RemoteTab() {
  const { agents } = useAgents();
  const onlineAgents = useMemo(() => agents.filter((a) => a.status !== 'offline'), [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'failed'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const [dcReady, setDcReady] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const stopFlag = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  // Coalesce mouse_move on requestAnimationFrame.
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const rafScheduled = useRef(false);

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
    setControlling(false);
    setDcReady(false);
    if (document.pointerLockElement === videoRef.current) {
      try { document.exitPointerLock(); } catch { /* ignore */ }
    }
    if (dcRef.current) {
      try { dcRef.current.close(); } catch { /* ignore */ }
      dcRef.current = null;
    }
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

  const sendDC = (obj: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;
    // Drop new mouse_moves under back-pressure so we don't balloon latency.
    if (obj.t === 'mouse_move' && dc.bufferedAmount > 256 * 1024) return;
    try { dc.send(JSON.stringify(obj)); } catch { /* ignore */ }
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

      const pc = new RTCPeerConnection({ iceServers: credsBody.iceServers });
      pcRef.current = pc;

      // Control channel — created BEFORE the offer so SDP includes m=application.
      // The agent reads the DC via pc.on_data_channel.
      const dc = pc.createDataChannel('control', { ordered: true });
      dcRef.current = dc;
      dc.onopen = () => {
        setDcReady(true);
        sendDC({ t: 'hello', proto: 1 });
      };
      dc.onclose = () => { setDcReady(false); };
      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.t === 'clip_data' && typeof msg.text === 'string') {
            void navigator.clipboard.writeText(msg.text).catch(() => { /* ignore */ });
          }
          // screen_info / pong: nothing to do client-side right now.
        } catch { /* ignore non-JSON */ }
      };

      pc.ontrack = (ev) => {
        if (videoRef.current && ev.streams[0]) {
          videoRef.current.srcObject = ev.streams[0];
          videoRef.current.play().catch(() => { /* muted, no gesture needed */ });
        }
      };
      pc.oniceconnectionstatechange = () => {
        if (stopFlag.current) return;
        const s = pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') setStatus('live');
        else if (s === 'failed' || s === 'closed') {
          setStatus('failed');
          setErrorMsg(`Peer connection ${s}`);
        }
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          void postSignal(jwt, sessionId, agentId, 'to_agent', 'ice_candidate', ev.candidate.toJSON());
        }
      };

      pc.addTransceiver('video', { direction: 'recvonly' });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await postSignal(jwt, sessionId, agentId, 'to_agent', 'offer', { sdp: offer.sdp });
      void pollLoop(jwt, sessionId, pc);
    } catch (e) {
      console.error('remote stream start failed', e);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('failed');
      teardown();
    }
  };

  const pollLoop = async (jwt: string, sessionId: string, pc: RTCPeerConnection) => {
    let since = new Date(Date.now() - 5000).toISOString();
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

  // ---- Input capture wiring (only active while `controlling`) ----

  const enterControl = async () => {
    const v = videoRef.current;
    if (!v || !dcReady) return;
    try {
      await v.requestPointerLock();
      setControlling(true);
      v.focus();
    } catch (e) {
      console.warn('pointer lock failed', e);
    }
  };

  const exitControl = () => {
    if (document.pointerLockElement === videoRef.current) {
      try { document.exitPointerLock(); } catch { /* ignore */ }
    }
    setControlling(false);
  };

  // Watch for the user pressing Esc (browser exits pointer-lock unilaterally).
  useEffect(() => {
    const onChange = () => {
      if (document.pointerLockElement !== videoRef.current) setControlling(false);
    };
    document.addEventListener('pointerlockchange', onChange);
    return () => document.removeEventListener('pointerlockchange', onChange);
  }, []);

  // Heartbeat ping while controlling.
  useEffect(() => {
    if (!controlling) return;
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      sendDC({ t: 'ping', id: n });
    }, 2000);
    return () => window.clearInterval(id);
  }, [controlling]);

  // Mouse + keyboard handlers attached to the video element. We only wire
  // them when `controlling` is true so view-only mode is undisturbed.

  const onMouseMove = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    const v = videoRef.current;
    if (!v) return;
    const rect = v.getBoundingClientRect();
    // Pointer-lock mode: e.clientX/Y are still raw (browser reports last
    // visible position) — what we actually want is movementX/Y aggregated.
    // We track an absolute virtual cursor in the video's coordinate space.
    pendingMove.current = pendingMove.current || { x: rect.width / 2, y: rect.height / 2 };
    pendingMove.current.x = Math.max(0, Math.min(rect.width, pendingMove.current.x + e.movementX));
    pendingMove.current.y = Math.max(0, Math.min(rect.height, pendingMove.current.y + e.movementY));
    if (!rafScheduled.current) {
      rafScheduled.current = true;
      requestAnimationFrame(() => {
        rafScheduled.current = false;
        const p = pendingMove.current;
        if (!p) return;
        sendDC({ t: 'mouse_move', x: p.x / rect.width, y: p.y / rect.height });
      });
    }
  };

  const onMouseDown = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    sendDC({ t: 'mouse_button', btn: btnName(e.button), down: true });
  };
  const onMouseUp = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    sendDC({ t: 'mouse_button', btn: btnName(e.button), down: false });
  };
  const onWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    // Normalize to a small integer line count. enigo expects line units.
    const dy = Math.sign(e.deltaY) * Math.min(5, Math.ceil(Math.abs(e.deltaY) / 40));
    const dx = Math.sign(e.deltaX) * Math.min(5, Math.ceil(Math.abs(e.deltaX) / 40));
    if (dx || dy) sendDC({ t: 'mouse_wheel', dx, dy });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!controlling) return;
    e.preventDefault();
    // Cmd/Ctrl+C from the dashboard while controlling → ask agent to send
    // its clipboard; we'll write it locally when `clip_data` arrives.
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyC') {
      sendDC({ t: 'clip_get' });
    }
    // Cmd/Ctrl+V → push our local clipboard to the agent first, THEN let
    // the keystroke through so the agent's app handles paste normally.
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') {
      void navigator.clipboard.readText().then((text) => sendDC({ t: 'clip_set', text }))
        .catch(() => { /* permission denied: best-effort */ });
    }
    sendDC({ t: 'key', code: e.code, down: true });
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!controlling) return;
    e.preventDefault();
    sendDC({ t: 'key', code: e.code, down: false });
  };

  // Bind global keyboard listeners while controlling (the <video> element
  // itself doesn't keep keyboard focus reliably across all browsers).
  useEffect(() => {
    if (!controlling) return;
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlling]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none"
          >
            <option value="">Select agent…</option>
            {onlineAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.machine})</option>
            ))}
          </select>
          {selectedId && !controlling && (
            <button
              disabled={!dcReady}
              onClick={() => void enterControl()}
              className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed border border-emerald-500/30 text-emerald-300 text-xs font-medium"
            >
              Take Control
            </button>
          )}
          {controlling && (
            <button
              onClick={exitControl}
              className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-xs font-medium"
            >
              Release (Esc)
            </button>
          )}
          {selectedId && (
            <button
              onClick={() => { stopFlag.current = true; setSelectedId(null); teardown(); }}
              className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium"
            >
              Stop
            </button>
          )}
        </div>
        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${
          controlling ? 'bg-red-500/15 text-red-300'
          : status === 'live' ? 'bg-emerald-500/15 text-emerald-300'
          : status === 'connecting' ? 'bg-amber-500/15 text-amber-300'
          : status === 'failed' ? 'bg-red-500/15 text-red-300'
          : 'bg-dark-800 text-gray-400'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${
            controlling ? 'bg-red-400 animate-pulse'
            : status === 'live' ? 'bg-emerald-400 animate-pulse'
            : status === 'connecting' ? 'bg-amber-400 animate-pulse'
            : status === 'failed' ? 'bg-red-400'
            : 'bg-gray-500'
          }`} />
          {controlling ? 'CONTROLLING'
            : status === 'live' ? 'Live'
            : status === 'connecting' ? 'Connecting…'
            : status === 'failed' ? (errorMsg ?? 'Failed')
            : 'Idle'}
        </span>
      </div>

      <div className="aspect-video bg-dark-900 border border-dark-700 rounded-xl overflow-hidden relative">
        {selectedId ? (
          <video
            ref={videoRef}
            tabIndex={0}
            onMouseMove={onMouseMove}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
            className={`w-full h-full object-contain bg-black ${controlling ? 'cursor-none' : ''}`}
            autoPlay
            playsInline
            muted
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
                <i className="ri-remote-control-2-line text-3xl" />
              </span>
              <p className="text-sm text-gray-400">Select an online agent to take remote control.</p>
              <p className="text-[11px] text-gray-600 mt-1">Requires the agent on v0.2.32+ with Accessibility permission (macOS).</p>
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

function btnName(b: number): 'left' | 'right' | 'middle' {
  return b === 2 ? 'right' : b === 1 ? 'middle' : 'left';
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
