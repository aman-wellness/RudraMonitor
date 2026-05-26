import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgents } from '@/lib/dataHooks';
import {
  connectToAgent,
  sendControl,
  ConnectionState,
  type RoomHandle,
  type RemoteTrack,
} from '@/lib/livekit-client';

// LiveKit-powered Remote Desktop tab.
//
// Same UX as the previous webrtc-rs build (Take Control, Stop, Expand,
// Fullscreen, Copy/Paste-to-remote, on-video reticle, no pointer lock)
// but with all the WebRTC plumbing replaced by LiveKit's SDK:
//   * connectToAgent() mints a JWT and joins room `agent_<agent_id>`.
//   * Agent's screen arrives via track.attach(<video>).
//   * Mouse/keyboard/clipboard events flow over LiveKit's reliable
//     data channel (room.localParticipant.publishData) with the SAME
//     JSON wire protocol the agent handler already speaks.
//
// 800 lines of ICE / SDP / signaling code dropped — LiveKit's SDK
// owns all of it.

const btnName = (b: number) => (b === 0 ? 'left' : b === 2 ? 'right' : 'middle');

export default function RemoteTab() {
  const { agents } = useAgents();
  const onlineAgents = useMemo(() => agents.filter((a) => a.status !== 'offline'), [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'failed'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const [reticle, setReticle] = useState<{ x: number; y: number } | null>(null);
  const [clipStatus, setClipStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<RoomHandle | null>(null);
  const clipTimerRef = useRef<number | null>(null);

  const showClipStatus = (kind: 'ok' | 'err', text: string) => {
    setClipStatus({ kind, text });
    if (clipTimerRef.current) window.clearTimeout(clipTimerRef.current);
    clipTimerRef.current = window.setTimeout(() => setClipStatus(null), 4000);
  };

  // ------- Connection lifecycle -------
  useEffect(() => {
    if (!selectedId) return;
    setStatus('connecting');
    setErrorMsg(null);
    let cancelled = false;

    const attach = (track: RemoteTrack) => {
      const v = videoRef.current;
      if (!v || cancelled) return;
      track.attach(v);
      v.muted = true;
      v.playsInline = true;
      void v.play().catch(() => { /* ignore gesture lock */ });
    };
    const onData = (text: string) => {
      try {
        const msg = JSON.parse(text);
        if (msg.t === 'clip_data' && typeof msg.text === 'string') {
          if (!msg.text) {
            showClipStatus('err', 'Remote clipboard is empty');
            return;
          }
          navigator.clipboard.writeText(msg.text).then(() => {
            const preview = msg.text.length > 40 ? msg.text.slice(0, 40) + '…' : msg.text;
            showClipStatus('ok', `Copied from remote: "${preview}"`);
          }).catch((err) => {
            showClipStatus('err', `Couldn't write to your clipboard: ${err?.message ?? err}`);
          });
        }
      } catch { /* ignore non-JSON */ }
    };

    (async () => {
      try {
        const h = await connectToAgent({
          agentId: selectedId,
          onVideoTrack: attach,
          onData,
          onState: (state) => {
            if (cancelled) return;
            if (state === ConnectionState.Connected) setStatus('live');
            else if (state === ConnectionState.Disconnected) setStatus('idle');
            else if (state === ConnectionState.Reconnecting) setStatus('connecting');
          },
        });
        if (cancelled) { void h.close(); return; }
        handleRef.current = h;
        // Send hello so the agent emits its screen_info (used for any
        // future per-monitor coord work).
        void sendControl(h.room, { t: 'hello', proto: 1 });
      } catch (e) {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
      setControlling(false);
      void handleRef.current?.close();
      handleRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [selectedId]);

  // ------- Controls -------
  const sendCtl = (obj: Record<string, unknown>) => {
    const room = handleRef.current?.room;
    if (!room) return;
    void sendControl(room, obj);
  };
  const enterControl = () => { setControlling(true); videoRef.current?.focus(); };
  const exitControl = () => setControlling(false);

  // Esc to release control without going for the Stop button.
  useEffect(() => {
    if (!controlling) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setControlling(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [controlling]);

  // Fullscreen / Expand tracking.
  useEffect(() => {
    const f = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) await document.exitFullscreen();
    else await el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  };

  // ------- Mouse + keyboard handlers -------
  const onMouseMove = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    const v = videoRef.current;
    if (!v) return;
    const rect = v.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    setReticle({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    sendCtl({ t: 'mouse_move', x, y });
  };
  const onMouseDown = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    sendCtl({ t: 'mouse_button', btn: btnName(e.button), down: true });
  };
  const onMouseUp = (e: React.MouseEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    sendCtl({ t: 'mouse_button', btn: btnName(e.button), down: false });
  };
  const onWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    const dy = Math.sign(e.deltaY) * Math.min(5, Math.ceil(Math.abs(e.deltaY) / 40));
    const dx = Math.sign(e.deltaX) * Math.min(5, Math.ceil(Math.abs(e.deltaX) / 40));
    if (dx || dy) sendCtl({ t: 'mouse_wheel', dx, dy });
  };
  useEffect(() => {
    if (!controlling) return;
    const kd = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return; // handled by exit-control effect
      e.preventDefault();
      sendCtl({ t: 'key', code: e.code, down: true });
    };
    const ku = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      e.preventDefault();
      sendCtl({ t: 'key', code: e.code, down: false });
    };
    window.addEventListener('keydown', kd, true);
    window.addEventListener('keyup', ku, true);
    return () => {
      window.removeEventListener('keydown', kd, true);
      window.removeEventListener('keyup', ku, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlling]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            disabled={onlineAgents.length === 0}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">{onlineAgents.length === 0 ? 'No online agents' : 'Select agent…'}</option>
            {onlineAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.machine})</option>
            ))}
          </select>

          {selectedId && !controlling && (
            <button
              disabled={status !== 'live'}
              onClick={enterControl}
              className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed border border-emerald-500/30 text-emerald-300 text-xs font-medium"
            >Take Control</button>
          )}
          {controlling && (
            <>
              <button onClick={exitControl} className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-xs font-medium">Release (Esc)</button>
              <button
                onClick={() => sendCtl({ t: 'clip_get' })}
                title="Copy the remote machine's clipboard into yours"
                className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-600 text-gray-200 text-xs font-medium"
              ><i className="ri-arrow-down-line mr-1" />Copy from remote</button>
              <button
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (!text) { showClipStatus('err', 'Your clipboard is empty'); return; }
                    sendCtl({ t: 'clip_set', text });
                    const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
                    showClipStatus('ok', `Pushed to remote: "${preview}"`);
                  } catch (err) {
                    showClipStatus('err', `Couldn't read your clipboard: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }}
                title="Push your clipboard to the remote machine"
                className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-600 text-gray-200 text-xs font-medium"
              ><i className="ri-arrow-up-line mr-1" />Paste to remote</button>
              {clipStatus && (
                <span className={`px-2.5 py-1 text-[11px] rounded border ${clipStatus.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' : 'bg-rose-500/10 text-rose-300 border-rose-500/30'}`}>{clipStatus.text}</span>
              )}
            </>
          )}

          {selectedId && (
            <>
              <button onClick={() => setExpanded((v) => !v)} title={expanded ? 'Shrink' : 'Expand'} className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium">
                <i className={`mr-1 ${expanded ? 'ri-collapse-diagonal-line' : 'ri-expand-diagonal-line'}`} />
                {expanded ? 'Shrink' : 'Expand'}
              </button>
              <button onClick={() => void toggleFullscreen()} title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Open agent screen in fullscreen'} className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium">
                <i className={`mr-1 ${isFullscreen ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line'}`} />
                {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              </button>
              <button onClick={() => setSelectedId(null)} className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium">Stop</button>
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
          {controlling ? 'CONTROLLING' : status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : status === 'failed' ? (errorMsg ?? 'Failed') : 'Idle'}
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
              onMouseLeave={() => { if (controlling) setReticle(null); }}
              onWheel={onWheel}
              onContextMenu={(e) => e.preventDefault()}
              className={`w-full h-full object-contain bg-black ${controlling ? 'cursor-none' : ''}`}
              autoPlay
              playsInline
              muted
            />
            {controlling && reticle && (
              <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: reticle.x, top: reticle.y }}>
                <div className="w-5 h-5 rounded-full border-2 border-emerald-400 bg-emerald-400/20 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
                <div className="absolute inset-0 m-auto w-1 h-1 rounded-full bg-emerald-200" />
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-center">
            <div>
              <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
                <i className="ri-remote-control-2-line text-3xl" />
              </span>
              <p className="text-sm text-gray-400">Select an online agent to take remote control.</p>
              <p className="text-[11px] text-gray-600 mt-1">Requires agent v0.3.0+ (LiveKit publisher) and macOS Accessibility permission.</p>
            </div>
          </div>
        )}
      </div>

      {status === 'failed' && errorMsg && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-3 text-xs text-rose-300 flex items-center justify-between gap-3">
          <span>Error: {errorMsg}</span>
          <button onClick={() => { const s = selectedId; setSelectedId(null); setTimeout(() => setSelectedId(s), 200); }} className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-100">Retry</button>
        </div>
      )}
    </div>
  );
}
