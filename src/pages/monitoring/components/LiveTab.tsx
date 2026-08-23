// Live monitoring tab — LiveKit-backed.
//
// Architecture (post-pivot):
//   1. User picks an agent → we mint a livekit-token (canSubscribe=true).
//   2. We POST `livekit_start` to webrtc-signal; agent's whip_publisher
//      sees it and starts WHIP-publishing its screen into the room
//      `agent_<id>` on the self-hosted LiveKit OSS.
//   3. We connect to the same room as a subscriber via livekit-client.
//      LiveKit fans out the agent's video track to us.
//   4. First subscribed video track attaches to <video>; we render.
//   5. On unmount / agent-switch we POST `livekit_stop` and disconnect.
//
// Compared to the legacy webrtc-signal path this is ~150 lines instead
// of ~290 and the failure surface is dramatically smaller — codec
// negotiation, TURN, jitter buffer, congestion control all live inside
// LiveKit. The DIY signaling pieces that gave us black-screen / bytes=0
// for weeks are gone.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionState, type RemoteTrack, type Room } from 'livekit-client';
import { useAgents } from '@/lib/dataHooks';
import { connectToAgent } from '@/lib/livekit-client';
import { startRelaySession, relayFallbackSupported, type RelaySession } from '@/lib/relayClient';

type Status = 'idle' | 'connecting' | 'live' | 'failed';

export default function LiveTab() {
  const { agents } = useAgents();
  const onlineAgents = useMemo(() => agents.filter((a) => a.status !== 'offline'), [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [stats, setStats] = useState<{ width: number; height: number; bitrate: number; fps: number } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handleRef = useRef<{ leave: () => Promise<void>; room: Room } | null>(null);
  const trackRef = useRef<RemoteTrack | null>(null);
  // Relay fallback for Live View. LiveKit needs the agent to reach the SFU over
  // UDP; when the employee's network blocks that, LiveKit never gets a track
  // and we fall back to the TLS-443 relay (same path Remote uses). One attempt
  // per selected agent.
  const relayRef = useRef<RelaySession | null>(null);
  const triedRelayRef = useRef(false);

  // Re-establish the room whenever the selected agent changes.
  useEffect(() => {
    if (!selectedId) {
      void teardown();
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('connecting');
    setErrorMsg(null);
    setStats(null);
    (async () => {
      try {
        const sessionId = crypto.randomUUID();
        const handle = await connectToAgent({
          agentId: selectedId,
          sessionId,
          onConnectionState: (cs) => {
            if (cancelled) return;
            if (cs === ConnectionState.Connected) {
              // ConnectionState.Connected fires before the first video
              // arrives. Don't flip to "live" yet — we wait for the
              // TrackSubscribed callback below so the pill is honest.
            } else if (cs === ConnectionState.Reconnecting) {
              setStatus('connecting');
            } else if (cs === ConnectionState.Disconnected) {
              setStatus('failed');
              setErrorMsg('disconnected');
            }
          },
          onTrack: (track) => {
            if (cancelled || track.kind !== 'video') return;
            trackRef.current = track;
            if (videoRef.current) {
              track.attach(videoRef.current);
              videoRef.current.play().catch(() => { /* autoplay-allowed; muted */ });
            }
            setStatus('live');
          },
          onError: (e) => {
            if (cancelled) return;
            setErrorMsg(e.message);
          },
        });
        if (cancelled) {
          await handle.leave();
          return;
        }
        handleRef.current = handle;
        // Belt-and-braces: if no video arrives within 90s, mark failed.
        // Root causes differ per OS, so tailor the hint accordingly —
        // customers pinged us with the wrong-OS text on 2026-07-24.
        const selectedAgent = onlineAgents.find((a) => a.id === selectedId);
        const os = (selectedAgent?.os ?? '').toLowerCase();
        const hint = os.includes('mac')
          ? 'Most common cause on macOS: Screen Recording permission not granted. On the target Mac open System Settings → Privacy & Security → Screen Recording → toggle "Security Assistant" on, then quit + relaunch the agent from Applications.'
          : os.includes('win')
            ? 'Windows Defender first-run scan can take 30–60 s — try once more. If it still fails, verify the agent process is running under the correct user session.'
            : 'Ensure the agent is running on the target machine and has permission to record the screen.';
        const noTrackTimer = setTimeout(() => {
          if (!cancelled && status !== 'live' && !trackRef.current) {
            setStatus('failed');
            setErrorMsg(`Agent did not publish video within 90 s. ${hint}`);
          }
        }, 90_000);
        // Cleanup also clears this timer.
        const _origLeave = handle.leave;
        handle.leave = async () => { clearTimeout(noTrackTimer); await _origLeave(); };
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

  // Stats poll — pulls dimensions + bitrate + fps from the WebRTC
  // receiver. Lets us show "connecting but no bytes" diagnostics if a
  // session goes sideways.
  useEffect(() => {
    if (status !== 'live') return;
    const id = window.setInterval(async () => {
      const room = handleRef.current?.room;
      if (!room) return;
      const pubs = Array.from(room.remoteParticipants.values())
        .flatMap((p) => Array.from(p.videoTrackPublications.values()));
      const pub = pubs[0];
      const stats = await pub?.track?.getRTCStatsReport();
      if (!stats) return;
      let width = 0, height = 0, fps = 0, bitrate = 0;
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          width = (s as { frameWidth?: number }).frameWidth ?? 0;
          height = (s as { frameHeight?: number }).frameHeight ?? 0;
          fps = Math.round((s as { framesPerSecond?: number }).framesPerSecond ?? 0);
          bitrate = (s as { bytesReceived?: number }).bytesReceived ?? 0;
        }
      });
      setStats({ width, height, fps, bitrate });
    }, 1000);
    return () => window.clearInterval(id);
  }, [status]);

  const teardown = async () => {
    const t = trackRef.current;
    if (t && videoRef.current) {
      try { t.detach(videoRef.current); } catch { /* ignore */ }
    }
    trackRef.current = null;
    if (relayRef.current) {
      try { relayRef.current.stop(); } catch { /* already down */ }
      relayRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    triedRelayRef.current = false;
    const h = handleRef.current;
    handleRef.current = null;
    if (h) await h.leave();
  };

  // Relay fallback trigger. When the LiveKit path fails before any video
  // arrived, try once over the TLS-443 relay so an employee on a UDP-blocked
  // network is still viewable. View-only: we attach the relay's stream but send
  // no input.
  useEffect(() => {
    if (status !== 'failed' || !selectedId) return;
    if (triedRelayRef.current || relayRef.current) return;
    if (!relayFallbackSupported()) return;
    triedRelayRef.current = true;
    const agentId = selectedId;
    // Hang up the failed LiveKit connection BEFORE opening the relay (audit
    // H16). Otherwise the agent keeps publishing to LiveKit in the background
    // while the relay also runs — a leaked stream that only closes on
    // agent-switch/unmount, and stacks up across repeated failures. We stop
    // just the LiveKit handle here (not the full teardown(), which would reset
    // the relay guard and loop).
    if (handleRef.current) {
      void handleRef.current.leave();
      handleRef.current = null;
    }
    if (trackRef.current && videoRef.current) {
      try { trackRef.current.detach(videoRef.current); } catch { /* ignore */ }
      trackRef.current = null;
    }
    setStatus('connecting');
    setErrorMsg('Direct path blocked — connecting via relay…');
    const sessionId = crypto.randomUUID();
    relayRef.current = startRelaySession(agentId, sessionId, {
      onPhase: (p, d) => {
        if (p === 'failed') { setStatus('failed'); setErrorMsg(d ?? 'relay failed'); }
      },
      onTrack: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => { /* muted autoplay */ });
        }
        setStatus('live');
        setErrorMsg(null);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, selectedId]);

  const tone = status === 'live' ? 'var(--d-success)'
    : status === 'connecting' ? 'var(--d-warning)'
    : status === 'failed' ? 'var(--d-danger)'
    : 'var(--d-neutral)';

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            disabled={onlineAgents.length === 0}
            className="filter-date disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ minWidth: 190 }}
          >
            <option value="">
              {onlineAgents.length === 0 ? 'No agents reporting' : 'Select agent…'}
            </option>
            {onlineAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.machine})
              </option>
            ))}
          </select>
          {selectedId && (
            <button onClick={() => setSelectedId(null)} className="chip chip-danger text-[10.5px]">
              <i className="ri-stop-circle-line" />
              Stop
            </button>
          )}
        </div>
        {/* The status word comes from the room's actual state — 'live' only once
            a video track has arrived, not when the socket connects. */}
        <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: tone }}>
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              status === 'live' || status === 'connecting' ? 'animate-pulse' : ''
            }`}
            style={{ background: tone }}
          />
          {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : status === 'failed' ? 'Failed' : 'Idle'}
        </span>
      </div>

      {selectedId ? (
        <div className="panel aspect-video overflow-hidden relative">
          <>
            <video
              ref={videoRef}
              className="w-full h-full object-contain bg-black"
              autoPlay
              playsInline
              muted
              onDoubleClick={() => { void videoRef.current?.requestFullscreen?.(); }}
            />
            {/* Fullscreen toggle. Calls Fullscreen API on the <video>
                element directly — that's what gives an immersive view
                with native controls overlay, vs fullscreen-ing the
                container which keeps the dashboard chrome around it.
                Double-click on the video itself also works (above). */}
            <button
              type="button"
              onClick={() => { void videoRef.current?.requestFullscreen?.(); }}
              className="absolute bottom-2.5 right-2.5 text-white text-[11px] px-2 py-1 rounded-md flex items-center gap-1.5 transition-opacity hover:opacity-80"
              style={{ background: 'rgba(0,0,0,0.7)' }}
              title="Fullscreen (or double-click the video)"
              aria-label="Enter fullscreen"
            >
              <i className="ri-fullscreen-line text-[13px]" />
              Fullscreen
            </button>
            {stats && (
              <div
                className="absolute top-2 right-2 text-[10px] font-mono px-2 py-1.5 rounded leading-tight space-y-0.5 pointer-events-none"
                style={{ background: 'rgba(0,0,0,0.7)', color: 'rgba(255,255,255,0.65)' }}
              >
                <div>{stats.width}×{stats.height} · <span className="text-white">{stats.fps}</span> fps</div>
                <div>{stats.bitrate.toLocaleString()} bytes</div>
              </div>
            )}
            {status === 'connecting' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center px-6">
                  <div
                    className="w-9 h-9 rounded-full mx-auto mb-3 animate-spin"
                    style={{
                      border: '2px solid var(--d-line)',
                      borderTopColor: 'var(--d-warning)',
                    }}
                  />
                  <p className="text-[12.5px] t-warning">Connecting to agent…</p>
                  <p className="text-[11px] t3 mt-1.5 max-w-md mx-auto leading-relaxed">
                    First Live View on a Windows machine after a fresh agent install can take 30-60 s
                    while Windows Defender scans the bundled encoder. Subsequent sessions start within 2-3 s.
                  </p>
                </div>
              </div>
            )}
            {status === 'failed' && (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <div className="text-center max-w-md">
                  <i className="ri-error-warning-line text-[22px] t-danger block mb-2" />
                  <p className="text-[12.5px] t-danger">Connection failed</p>
                  {errorMsg && (
                    <p className="text-[11px] t3 mt-1.5 leading-relaxed">{errorMsg}</p>
                  )}
                </div>
              </div>
            )}
          </>
        </div>
      ) : (
        <div className="panel p-10">
          <div className="flex items-center justify-center">
            <div className="text-center max-w-sm">
              <i className="ri-broadcast-line text-[24px] t3 block mb-2" />
              <p className="text-[12.5px] t2">
                {onlineAgents.length === 0
                  ? 'No agents are reporting right now'
                  : 'Pick an agent above to start a live stream'}
              </p>
              <p className="text-[11px] t3 mt-1.5 leading-relaxed">
                {onlineAgents.length === 0
                  ? 'A live stream needs the agent running and checking in — enrolled but silent machines cannot be viewed.'
                  : 'Requires the agent on v0.2.52+ with Screen Recording permission granted.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
