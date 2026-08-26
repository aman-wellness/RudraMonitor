import { useCallback, useEffect, useRef, useState } from 'react';
import { startRemoteSessionWithFallback, type Phase, type RemoteSession } from '@/lib/remoteControl';
import { notify } from '@/lib/notify';

/* The interactive remote screen.
 *
 * Everything latency-sensitive is here, so the choices worth knowing:
 *
 *  • Mouse moves are sent on requestAnimationFrame, not on every pointermove.
 *    A trackpad fires well over 200 events/second; forwarding each one floods
 *    the ordered DataChannel and, because it is ordered, a backlog delays every
 *    KEYSTROKE behind it too. Coalescing to the frame rate keeps the cursor
 *    smooth and the channel clear.
 *  • Input is opt-in: the operator arms it with "Take control" and releases it
 *    with Escape. Viewing without arming is the default, so a session opened
 *    to look at something cannot move the employee's mouse by accident.
 *  • Keys are captured with preventDefault so browser shortcuts (Ctrl+W,
 *    Ctrl+T, F5) act on the remote machine instead of closing the operator's
 *    own tab. That is also why they are only captured while armed.
 *  • Clipboard syncs on the shortcuts themselves: Ctrl/Cmd+V pushes the
 *    operator's clipboard to the remote just before the paste (the keydown is
 *    the user gesture the browser requires to read it), and Ctrl/Cmd+C pulls
 *    the remote's clipboard back afterwards. The explicit Send/Get buttons
 *    remain for when a browser blocks the out-of-gesture write.
 *  • A small file can be pushed to the remote machine's Downloads folder via
 *    the "Send file" button or by dragging it onto the screen.
 */

type Props = { agentId: string; agentName: string; onClose: () => void };

const PHASE_TEXT: Record<Phase, string> = {
  idle: 'Idle',
  signalling: 'Negotiating…',
  connecting: 'Connecting…',
  connected: 'Connected',
  failed: 'Failed',
  closed: 'Disconnected',
};

const BUTTONS: Record<number, 'left' | 'middle' | 'right'> = {
  0: 'left', 1: 'middle', 2: 'right',
};

export default function RemoteStage({ agentId, agentName, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<RemoteSession | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [screen, setScreen] = useState<{ w: number; h: number } | null>(null);
  const [controlling, setControlling] = useState(false);

  // Pending pointer position, flushed once per frame.
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  // ICE negotiation is not reliably first-time. Chrome publishes its host
  // candidates as mDNS names and its reflexive candidate at the public IP, so
  // whether a usable pair is found depends on mDNS resolution and on whether a
  // relay allocation survives — none of which is deterministic. Measured locally
  // at roughly one failure in three on identical code.
  //
  // A fresh offer usually succeeds, so retry rather than making the operator
  // click again. Each attempt costs ~8s (the watchdog in remoteControl) rather
  // than the ~30s WebRTC takes to give up on its own, so five attempts fit
  // inside a wait an operator will tolerate. Bounded, because retrying forever
  // against a genuinely unreachable agent would only hide the problem.
  const MAX_ATTEMPTS = 5;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let retried = false;
    let connectedOnce = false;
    const s = startRemoteSessionWithFallback(agentId, {
      onPhase: (p, d) => {
        setPhase(p);
        setDetail(d ?? null);
        if (p === 'connected') connectedOnce = true;
        // Only retry a failure that happened BEFORE we ever connected (audit
        // M11). A drop AFTER a working session is a transient blip WebRTC can
        // recover on its own — tearing the whole session down and re-negotiating
        // would interrupt the operator for nothing. (The comment always said
        // this; now the code actually tracks it.)
        if (p === 'failed' && !connectedOnce && !retried && attempt + 1 < MAX_ATTEMPTS) {
          retried = true;
          setDetail(`Negotiation failed, retrying (${attempt + 2} of ${MAX_ATTEMPTS})…`);
          // Remount with a new session by bumping the attempt counter.
          window.setTimeout(() => setAttempt((a) => a + 1), 400);
        }
      },
      onTrack: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => { /* autoplay policy; muted so this is rare */ });
        }
      },
      onScreenInfo: (w, h) => setScreen({ w, h }),
      onLatency: setLatency,
      onClipboard: async (text) => {
        // The agent proactively pushes a clip_data every ~500 ms while
        // its clipboard changes (see webrtc_stream::spawn_clipboard_sync),
        // so this handler fires without a user gesture. Chrome/Firefox
        // block navigator.clipboard.writeText() outside of a gesture,
        // which used to make "just press Ctrl+V after copying on the
        // remote" fail silently.
        //
        // Two-layer strategy:
        //   1. Try the modern API. In a focused tab with prior clipboard
        //      permission it works even without a fresh gesture.
        //   2. Fall back to the legacy execCommand('copy') via a hidden
        //      textarea. Not gesture-scoped and still supported by every
        //      current browser.
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch { /* fall through to legacy path */ }
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          ta.style.pointerEvents = 'none';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        } catch { /* nothing else to try — operator can use "Get clipboard" */ }
      },
    });
    sessionRef.current = s;
    return () => { s.stop(); sessionRef.current = null; };
    // `attempt` in the deps is what performs the retry: bumping it tears the old
    // session down through the cleanup above and starts a fresh negotiation.
  }, [agentId, attempt]);

  // ---- pointer ------------------------------------------------------------
  const flush = useCallback(() => {
    rafRef.current = null;
    const p = pendingMove.current;
    const el = videoRef.current;
    if (!p || !el || !sessionRef.current) return;
    pendingMove.current = null;
    sessionRef.current.sendPointer(el, p.x, p.y);
  }, []);

  const onPointerMove = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    pendingMove.current = { x: e.clientX, y: e.clientY };
    // Coalesce: one send per animation frame no matter how many events arrive.
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flush);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    (e.currentTarget as HTMLVideoElement).focus();
    const btn = BUTTONS[e.button];
    if (!btn) return;
    // Send the position first: a click at a stale cursor position lands in the
    // wrong place, and the coalesced move may not have flushed yet.
    sessionRef.current?.sendPointer(e.currentTarget, e.clientX, e.clientY);
    sessionRef.current?.send({ t: 'mouse_button', btn, down: true });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    const btn = BUTTONS[e.button];
    if (btn) sessionRef.current?.send({ t: 'mouse_button', btn, down: false });
  };

  const onWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    if (!controlling) return;
    e.preventDefault();
    // Normalise to notches. deltaMode 0 is pixels (trackpads report ~100 per
    // notch); enigo scrolls in lines, so raw pixel deltas would fly.
    const unit = e.deltaMode === 0 ? 100 : 1;
    const dy = Math.round(-e.deltaY / unit) || (e.deltaY > 0 ? -1 : 1);
    const dx = Math.round(e.deltaX / unit);
    sessionRef.current?.send({ t: 'mouse_wheel', dx, dy });
  };

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    if (!controlling) return;
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      // Let the operator out without the remote machine seeing it.
      if (e.key === 'Escape' && down) { setControlling(false); return; }
      // Claim the key before the browser acts on it, so Ctrl+W closes a window
      // on the AGENT rather than the operator's tab.
      e.preventDefault();
      e.stopPropagation();
      const mod = e.ctrlKey || e.metaKey;
      // Seamless PASTE: right before the remote sees Ctrl/Cmd+V, push our own
      // clipboard to it so the paste uses what the operator just copied here.
      // A keydown is a user gesture, so the browser allows the read. We delay
      // only this one keydown (a few ms) until the clipboard is synced.
      if (down && mod && e.code === 'KeyV') {
        void navigator.clipboard.readText()
          .then((text) => sessionRef.current?.send({ t: 'clip_set', text }))
          .catch(() => { /* no permission: falls back to the remote's clipboard */ })
          .finally(() => sessionRef.current?.send({ t: 'key', code: e.code, down }));
        return;
      }
      sessionRef.current?.send({ t: 'key', code: e.code, down });
      // Seamless COPY: after a copy/cut on the remote, pull its clipboard back
      // to ours so the operator can paste locally. Best-effort — the browser
      // may block the out-of-gesture write; "Get clipboard" always works.
      if (!down && mod && (e.code === 'KeyC' || e.code === 'KeyX')) {
        window.setTimeout(() => sessionRef.current?.send({ t: 'clip_get' }), 120);
      }
    };
    const kd = onKey(true);
    const ku = onKey(false);
    // Capture phase, so nothing in the app intercepts first.
    window.addEventListener('keydown', kd, { capture: true });
    window.addEventListener('keyup', ku, { capture: true });
    return () => {
      window.removeEventListener('keydown', kd, { capture: true });
      window.removeEventListener('keyup', ku, { capture: true });
    };
  }, [controlling]);

  // Releasing control must not leave modifiers stuck down on the agent — the
  // employee would find their machine behaving as though Ctrl were held.
  useEffect(() => {
    if (controlling) return;
    for (const code of ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
      'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']) {
      sessionRef.current?.send({ t: 'key', code, down: false });
    }
  }, [controlling]);

  const pasteToRemote = async () => {
    try {
      const text = await navigator.clipboard.readText();
      sessionRef.current?.send({ t: 'clip_set', text });
      notify.success('Clipboard sent to the remote machine');
    } catch {
      notify.fail('Could not read your clipboard', 'Your browser needs permission to read it');
    }
  };

  // ---- file transfer (operator -> remote machine) -------------------------
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState<{ name: string; pct: number } | null>(null);

  const sendFile = useCallback(async (file: File | undefined | null) => {
    if (!file || !sessionRef.current || sending) return;
    setSending({ name: file.name, pct: 0 });
    try {
      const { savedAs } = await sessionRef.current.sendFile(file, (sent, total) => {
        setSending({ name: file.name, pct: total ? Math.round((sent / total) * 100) : 0 });
      });
      notify.success(`Sent "${file.name}" to the remote machine`,
        savedAs ? `Saved to ${savedAs}` : undefined);
    } catch (e) {
      notify.fail('File transfer failed', e instanceof Error ? e.message : undefined);
    } finally {
      setSending(null);
    }
  }, [sending]);

  const onDrop = (e: React.DragEvent) => {
    if (phase !== 'connected') return;
    e.preventDefault();
    void sendFile(e.dataTransfer.files?.[0]);
  };

  const tone = phase === 'connected' ? 't-success'
    : phase === 'failed' ? 't-danger' : 't-warning';

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[11.5px] ${tone} inline-flex items-center gap-1.5`}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'currentColor' }} />
            {PHASE_TEXT[phase]}
          </span>
          <span className="text-[11.5px] t2 truncate">{agentName}</span>
          {screen && <span className="text-[10.5px] t3 tnum">{screen.w}×{screen.h}</span>}
          {latency !== null && (
            <span className="text-[10.5px] t3 tnum" title="Control channel round-trip">
              {latency} ms
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setControlling((v) => !v)}
            disabled={phase !== 'connected'}
            className={`chip text-[10.5px] ${controlling ? 'chip-accent' : 'chip-quiet'} disabled:opacity-40`}
            title={controlling ? 'Stop sending input (or press Escape)' : 'Send mouse and keyboard to this machine'}
          >
            <i className={controlling ? 'ri-cursor-line' : 'ri-eye-line'} />
            {controlling ? 'Controlling — Esc to release' : 'Take control'}
          </button>
          <button
            onClick={() => void pasteToRemote()}
            disabled={phase !== 'connected'}
            className="chip chip-quiet text-[10.5px] disabled:opacity-40"
            title="Send your clipboard to the remote machine"
          >
            <i className="ri-clipboard-line" /> Send clipboard
          </button>
          <button
            onClick={() => sessionRef.current?.send({ t: 'clip_get' })}
            disabled={phase !== 'connected'}
            className="chip chip-quiet text-[10.5px] disabled:opacity-40"
            title="Copy the remote machine's clipboard to yours"
          >
            <i className="ri-file-copy-line" /> Get clipboard
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => { void sendFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={phase !== 'connected' || sending !== null}
            className="chip chip-quiet text-[10.5px] disabled:opacity-40"
            title="Send a file to the remote machine's Downloads folder (max 20 MB). You can also drag a file onto the screen."
          >
            <i className="ri-upload-2-line" />
            {sending ? `Sending ${sending.pct}%` : 'Send file'}
          </button>
          <button onClick={onClose} className="chip chip-quiet text-[10.5px]">
            <i className="ri-close-line" /> End
          </button>
        </div>
      </div>

      <div
        className="panel overflow-hidden relative aspect-video"
        onDragOver={(e) => { if (phase === 'connected') e.preventDefault(); }}
        onDrop={onDrop}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          tabIndex={0}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
          className="absolute inset-0 w-full h-full object-contain outline-none"
          style={{ cursor: controlling ? 'none' : 'default', background: '#000' }}
        />
        {sending && (
          <div className="absolute bottom-2 left-2 right-2 pointer-events-none">
            <div className="panel-2 rounded-md px-2.5 py-1.5 text-[10.5px] t2 flex items-center gap-2">
              <i className="ri-upload-2-line t-accent" />
              <span className="truncate flex-1">Sending {sending.name}</span>
              <span className="tnum t3">{sending.pct}%</span>
            </div>
          </div>
        )}
        {phase !== 'connected' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              {phase === 'failed' ? (
                <>
                  <i className="ri-error-warning-line text-[22px] t-danger block mb-2" />
                  <p className="text-[12.5px] t-danger">Could not connect</p>
                  {detail && <p className="text-[11px] t3 mt-1 max-w-sm">{detail}</p>}
                </>
              ) : (
                <>
                  <div
                    className="w-9 h-9 rounded-full mx-auto mb-3 animate-spin"
                    style={{ border: '2px solid var(--d-line)', borderTopColor: 'var(--d-accent)' }}
                  />
                  <p className="text-[12.5px] t1 font-medium">{PHASE_TEXT[phase]}</p>
                  <p className="text-[11px] t3 mt-1">
                    The agent answers on its next signalling poll.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <p className="text-[10.5px] t3">
        {controlling
          ? 'Mouse and keyboard are going to the remote machine. Ctrl/Cmd+C and Ctrl/Cmd+V sync the clipboard. Drag a file onto the screen to send it. Escape releases control.'
          : 'View only. Take control to send mouse and keyboard.'}
      </p>
    </div>
  );
}
