// Remote Desktop tab — LiveKit-backed.
//
// Same architecture as LiveTab (connect to room, subscribe to agent's
// video), PLUS:
//   • Publishes mouse + keyboard events via room.localParticipant
//     .publishData({ topic: 'control' }). The agent's whip_publisher
//     creates the "control" DataChannel on its side; LiveKit's SFU
//     fans data-channel traffic between participants, so the publish
//     surfaces in the agent's existing attach_control_channel handler.
//   • Receives `clip_data` replies via RoomEvent.DataReceived for the
//     clipboard round-trip.
//
// Old WebRTC-DataChannel plumbing (~800 lines) collapses to ~330 lines
// because livekit-client owns the reliability + chunking semantics.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ConnectionState,
  Room,
  RoomEvent,
  type RemoteTrack,
} from 'livekit-client';
import { useAgents } from '@/lib/dataHooks';
import { connectToAgent, sendControl } from '@/lib/livekit-client';

type Status = 'idle' | 'connecting' | 'live' | 'failed';

export default function RemoteTab() {
  const { agents } = useAgents();
  const onlineAgents = useMemo(() => agents.filter((a) => a.status !== 'offline'), [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const [clipStatus, setClipStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const clipTimer = useRef<number | null>(null);
  const showClip = (kind: 'ok' | 'err', text: string) => {
    setClipStatus({ kind, text });
    if (clipTimer.current) window.clearTimeout(clipTimer.current);
    clipTimer.current = window.setTimeout(() => setClipStatus(null), 4000);
  };

  // Viewing-size controls. Same UX as the legacy tab.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [reticle, setReticle] = useState<{ x: number; y: number } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handleRef = useRef<{ leave: () => Promise<void>; room: Room } | null>(null);
  const trackRef = useRef<RemoteTrack | null>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const rafScheduled = useRef(false);

  // Fullscreen API plumbing (unchanged from legacy).
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) await document.exitFullscreen();
      else await el.requestFullscreen({ navigationUI: 'hide' });
    } catch (e) { console.warn('fullscreen toggle failed', e); }
  };

  // Connect / reconnect when selectedId changes.
  useEffect(() => {
    if (!selectedId) {
      void teardown();
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('connecting');
    setErrorMsg(null);
    setControlling(false);
    (async () => {
      try {
        const sessionId = crypto.randomUUID();
        const handle = await connectToAgent({
          agentId: selectedId,
          sessionId,
          onConnectionState: (cs) => {
            if (cancelled) return;
            if (cs === ConnectionState.Reconnecting) setStatus('connecting');
            else if (cs === ConnectionState.Disconnected) {
              setStatus('failed');
              setErrorMsg('disconnected');
            }
          },
          onTrack: (track) => {
            if (cancelled || track.kind !== 'video') return;
            trackRef.current = track;
            if (videoRef.current) {
              track.attach(videoRef.current);
              videoRef.current.play().catch(() => { /* autoplay; muted */ });
            }
            setStatus('live');
          },
          onError: (e) => {
            if (cancelled) return;
            setErrorMsg(e.message);
          },
        });
        if (cancelled) { await handle.leave(); return; }
        handleRef.current = handle;
        // Listen for control replies (clipboard data from agent).
        const dec = new TextDecoder();
        handle.room.on(RoomEvent.DataReceived, (payload) => {
          try {
            const msg = JSON.parse(dec.decode(payload)) as { t?: string; text?: string };
            if (msg.t === 'clip_data' && typeof msg.text === 'string') {
              void navigator.clipboard.writeText(msg.text)
                .then(() => showClip('ok', `Copied from remote (${msg.text!.length} chars)`))
                .catch((err) => showClip('err', `Clipboard write blocked: ${(err as Error).message}`));
            }
          } catch { /* not JSON, ignore */ }
        });
      } catch (e) {
        if (cancelled) return;
        setStatus('failed');
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      void teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const teardown = async () => {
    setControlling(false);
    const t = trackRef.current;
    if (t && videoRef.current) {
      try { t.detach(videoRef.current); } catch { /* ignore */ }
    }
    trackRef.current = null;
    const h = handleRef.current;
    handleRef.current = null;
    if (h) await h.leave();
  };

  // Best-effort `setControlling(false)` on tab/window close so the
  // agent doesn't get a permanently-controlled session if the user
  // navigates away mid-session.
  useEffect(() => {
    const beforeUnload = () => { if (handleRef.current) void handleRef.current.leave(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  // Input → control DataChannel.
  const send = (obj: Record<string, unknown>) => {
    const room = handleRef.current?.room;
    if (!room) return;
    // No back-pressure check needed — livekit-client manages publish
    // queueing internally. Reliable channel ensures ordered delivery.
    void sendControl(room, obj);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    const v = videoRef.current;
    if (!v) return;
    const rect = v.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    pendingMove.current = { x, y };
    setReticle({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (!rafScheduled.current) {
      rafScheduled.current = true;
      requestAnimationFrame(() => {
        rafScheduled.current = false;
        const p = pendingMove.current;
        if (!p) return;
        send({ t: 'mouse_move', x: p.x, y: p.y });
      });
    }
  };
  const onMouseLeave = () => { if (controlling) setReticle(null); };
  const onMouseDown = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    send({ t: 'mouse_button', btn: btnName(e.button), down: true });
  };
  const onMouseUp = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    send({ t: 'mouse_button', btn: btnName(e.button), down: false });
  };
  const onWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    const dy = Math.sign(e.deltaY) * Math.min(5, Math.ceil(Math.abs(e.deltaY) / 40));
    const dx = Math.sign(e.deltaX) * Math.min(5, Math.ceil(Math.abs(e.deltaX) / 40));
    if (dx || dy) send({ t: 'mouse_wheel', dx, dy });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!controlling) return;
    e.preventDefault();
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyC') send({ t: 'clip_get' });
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyV') {
      void navigator.clipboard.readText()
        .then((text) => send({ t: 'clip_set', text }))
        .catch(() => { /* permission denied */ });
    }
    send({ t: 'key', code: e.code, down: true });
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!controlling) return;
    e.preventDefault();
    send({ t: 'key', code: e.code, down: false });
  };
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
        <div className="flex items-center gap-2 flex-wrap">
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
              <option key={a.id} value={a.id}>
                {a.name} ({a.machine})
              </option>
            ))}
          </select>
          {selectedId && !controlling && status === 'live' && (
            <button
              onClick={() => setControlling(true)}
              className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-medium"
            >
              Take Control
            </button>
          )}
          {controlling && (
            <>
              <button
                onClick={() => setControlling(false)}
                className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-xs font-medium"
              >
                Release (Esc)
              </button>
              <button
                onClick={() => send({ t: 'clip_get' })}
                title="Copy the remote machine's clipboard into yours"
                className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-600 text-gray-200 text-xs font-medium"
              >
                <i className="ri-arrow-down-line mr-1" />Copy from remote
              </button>
              <button
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (!text) { showClip('err', 'Your clipboard is empty'); return; }
                    send({ t: 'clip_set', text });
                    const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
                    showClip('ok', `Pushed to remote: "${preview}"`);
                  } catch (err) {
                    showClip('err', `Couldn't read your clipboard: ${(err as Error).message}`);
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
                }`}>{clipStatus.text}</span>
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
                onClick={() => setSelectedId(null)}
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
          <>
            <video
              ref={videoRef}
              tabIndex={0}
              onMouseMove={onMouseMove}
              onMouseDown={onMouseDown}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseLeave}
              onWheel={onWheel}
              onContextMenu={(e) => e.preventDefault()}
              className={`w-full h-full object-contain bg-black ${controlling ? 'cursor-none' : ''}`}
              autoPlay
              playsInline
              muted
            />
            {controlling && reticle && (
              <div
                className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
                style={{ left: reticle.x, top: reticle.y }}
              >
                <div className="w-5 h-5 rounded-full border-2 border-emerald-400 bg-emerald-400/20 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
                <div className="absolute inset-0 m-auto w-1 h-1 rounded-full bg-emerald-200" />
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
                <i className="ri-remote-control-2-line text-3xl" />
              </span>
              <p className="text-sm text-gray-400">Select an online agent to take remote control.</p>
              <p className="text-[11px] text-gray-600 mt-1">Requires the agent on v0.2.52+ with Accessibility permission (macOS).</p>
            </div>
          </div>
        )}
      </div>

      {status === 'failed' && errorMsg && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-3 text-xs text-rose-300 flex items-center justify-between gap-3">
          <span>Error: {errorMsg}</span>
          <button
            onClick={() => {
              const id = selectedId;
              if (!id) return;
              setSelectedId(null);
              setTimeout(() => setSelectedId(id), 200);
            }}
            className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-100"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function btnName(b: number): 'left' | 'right' | 'middle' {
  return b === 2 ? 'right' : b === 1 ? 'middle' : 'left';
}
