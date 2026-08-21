import { useCallback, useEffect, useRef, useState } from 'react';
import { startRemoteSession, type Phase, type RemoteSession } from '@/lib/remoteControl';
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
 *  • Clipboard is explicit both ways. Reading the local clipboard needs a user
 *    gesture in most browsers, so it cannot be done silently on Ctrl+V.
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
    const s = startRemoteSession(agentId, {
      onPhase: (p, d) => {
        setPhase(p);
        setDetail(d ?? null);
        // 'closed' after a successful connection is a normal hang-up; only a
        // failure before we ever connected is worth another attempt.
        if (p === 'failed' && !retried && attempt + 1 < MAX_ATTEMPTS) {
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
        try {
          await navigator.clipboard.writeText(text);
          notify.success('Copied from the remote machine');
        } catch {
          notify.fail('Could not write to your clipboard', 'Grant clipboard permission and retry');
        }
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
      sessionRef.current?.send({ t: 'key', code: e.code, down });
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
          <button onClick={onClose} className="chip chip-quiet text-[10.5px]">
            <i className="ri-close-line" /> End
          </button>
        </div>
      </div>

      <div className="panel overflow-hidden relative aspect-video">
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
          ? 'Mouse and keyboard are going to the remote machine. Escape releases control. Browser shortcuts are forwarded, not handled here.'
          : 'View only. Take control to send mouse and keyboard.'}
      </p>
    </div>
  );
}
