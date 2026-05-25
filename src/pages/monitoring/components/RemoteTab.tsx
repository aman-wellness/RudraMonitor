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
  // Short-lived status toast next to the Copy/Paste buttons so customers
  // can SEE whether the clipboard round-trip actually succeeded. Previously
  // the buttons fired silently; if the agent was on a stale build (which
  // it often was while the auto-update flow was still broken) nothing
  // happened and the customer assumed copy/paste was unimplemented.
  const [clipStatus, setClipStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const clipStatusTimer = useRef<number | null>(null);
  const showClipStatus = (kind: 'ok' | 'err', text: string) => {
    setClipStatus({ kind, text });
    if (clipStatusTimer.current) window.clearTimeout(clipStatusTimer.current);
    clipStatusTimer.current = window.setTimeout(() => setClipStatus(null), 4000);
  };

  // Viewing-size controls. Customers can't see the agent screen properly
  // in the default 16:9 inline frame, so:
  //   • Expand: video container takes over the full dashboard content
  //     area (still inside the React tree, sidebar/header visible).
  //   • Fullscreen: native HTML Fullscreen API — eats the entire monitor.
  //     Esc exits as usual.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch (e) {
      console.warn('fullscreen toggle failed', e);
    }
  };

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
            if (msg.text.length === 0) {
              showClipStatus('err', 'Remote clipboard is empty');
            } else {
              navigator.clipboard.writeText(msg.text).then(() => {
                const preview = msg.text.length > 40 ? msg.text.slice(0, 40) + '…' : msg.text;
                showClipStatus('ok', `Copied from remote: "${preview}"`);
              }).catch((err) => {
                showClipStatus('err', `Couldn't write to your clipboard: ${err?.message ?? err}`);
              });
            }
          }
          // screen_info / pong: nothing to do client-side right now.
        } catch { /* ignore non-JSON */ }
      };

      pc.ontrack = (ev) => {
        if (videoRef.current && ev.streams[0]) {
          videoRef.current.srcObject = ev.streams[0];
          videoRef.current.play().catch(() => { /* muted, no gesture needed */ });
        }
        // Tell the browser to use the smallest possible jitter buffer for
        // this track. The default tries to absorb network variance and
        // ends up adding 100-200 ms of latency — the operator feels that
        // as "cursor drag / hang" on the dashboard because their real
        // mouse has already moved on by the time the video catches up.
        // playoutDelayHint=0 hints "play it as soon as it arrives". Only
        // Chromium implements this property (Safari ignores the assignment
        // silently, which is fine — falls back to default behaviour).
        try {
          // Use Chromium's non-standard property without TS complaints.
          (ev.receiver as RTCRtpReceiver & { playoutDelayHint?: number }).playoutDelayHint = 0;
        } catch { /* ignore */ }
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

  // Control mode toggle. Previously this called requestPointerLock(), which
  // captured the dashboard user's mouse to the video element — the cursor
  // disappeared on their local desktop and they had to press Esc to escape.
  // Customers couldn't copy from agent and paste locally because the local
  // cursor was trapped. New behaviour matches AnyDesk / Chrome Remote
  // Desktop: control mode just enables event forwarding while the mouse
  // is over the video. Move off the video and you're back on your own
  // machine. No Esc dance, no captured cursor.
  const enterControl = () => {
    const v = videoRef.current;
    if (!v || !dcReady) return;
    setControlling(true);
    v.focus();
  };

  const exitControl = () => {
    setControlling(false);
  };

  // Esc still useful as a "stop sending input" shortcut even though we
  // no longer pointer-lock — saves a trip to the Stop button.
  useEffect(() => {
    if (!controlling) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setControlling(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controlling]);

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
    // Absolute positioning: pointer is NOT locked, so e.clientX/Y are
    // real cursor coordinates. Translate to normalized 0..1 inside the
    // video element. Drop events that wandered off the video — the
    // remote cursor freezes at its last in-bounds position, leaving the
    // user free to use their own machine.
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    pendingMove.current = { x, y };
    if (!rafScheduled.current) {
      rafScheduled.current = true;
      requestAnimationFrame(() => {
        rafScheduled.current = false;
        const p = pendingMove.current;
        if (!p) return;
        sendDC({ t: 'mouse_move', x: p.x, y: p.y });
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
            <>
              <button
                onClick={exitControl}
                className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-xs font-medium"
              >
                Release (Esc)
              </button>
              {/* Explicit clipboard sync buttons. The Ctrl+C / Ctrl+V
                  intercept on the video only fires when the video has
                  focus, and even then competes with the keystroke we
                  forward to the agent. Buttons remove the ambiguity:
                  one-shot copy from remote, one-shot paste to remote. */}
              <button
                onClick={() => {
                  if (!dcRef.current || dcRef.current.readyState !== 'open') {
                    showClipStatus('err', 'Not connected to remote');
                    return;
                  }
                  sendDC({ t: 'clip_get' });
                  showClipStatus('ok', 'Asking remote for its clipboard…');
                }}
                title="Copy the remote machine's clipboard into yours"
                className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-600 text-gray-200 text-xs font-medium"
              >
                <i className="ri-arrow-down-line mr-1" />Copy from remote
              </button>
              <button
                onClick={async () => {
                  if (!dcRef.current || dcRef.current.readyState !== 'open') {
                    showClipStatus('err', 'Not connected to remote');
                    return;
                  }
                  try {
                    const text = await navigator.clipboard.readText();
                    if (!text) {
                      showClipStatus('err', 'Your clipboard is empty');
                      return;
                    }
                    sendDC({ t: 'clip_set', text });
                    const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
                    showClipStatus('ok', `Pushed to remote: "${preview}"`);
                  } catch (err) {
                    // navigator.clipboard.readText() is gated behind a
                    // clipboard-read permission AND a user-gesture. Either
                    // missing → DOMException. Surface the reason so the
                    // customer knows to grant the permission in browser.
                    const e = err instanceof Error ? err.message : String(err);
                    showClipStatus('err', `Couldn't read your clipboard: ${e}`);
                  }
                }}
                title="Push your clipboard to the remote machine"
                className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-600 text-gray-200 text-xs font-medium"
              >
                <i className="ri-arrow-up-line mr-1" />Paste to remote
              </button>
              {clipStatus && (
                <span className={`px-2.5 py-1 text-[11px] rounded border ${
                  clipStatus.kind === 'ok'
                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                    : 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                }`}>
                  {clipStatus.text}
                </span>
              )}
            </>
          )}
          {selectedId && (
            <>
              <button
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? 'Shrink to default 16:9 frame' : 'Expand to fill the page'}
                className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium"
              >
                <i className={`mr-1 ${expanded ? 'ri-collapse-diagonal-line' : 'ri-expand-diagonal-line'}`} />
                {expanded ? 'Shrink' : 'Expand'}
              </button>
              <button
                onClick={() => void toggleFullscreen()}
                title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Open agent screen in fullscreen'}
                className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium"
              >
                <i className={`mr-1 ${isFullscreen ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line'}`} />
                {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              </button>
              <button
                onClick={() => { stopFlag.current = true; setSelectedId(null); teardown(); }}
                className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium"
              >
                Stop
              </button>
            </>
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

      <div
        ref={containerRef}
        className={
          isFullscreen
            ? 'fixed inset-0 z-50 bg-black flex items-center justify-center'
            : expanded
              ? 'h-[calc(100vh-160px)] bg-dark-900 border border-dark-700 rounded-xl overflow-hidden relative'
              : 'aspect-video bg-dark-900 border border-dark-700 rounded-xl overflow-hidden relative'
        }
      >
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
