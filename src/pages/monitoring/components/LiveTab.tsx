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
        // Belt-and-braces: if no video arrives within 12s, mark failed.
        // LiveKit's room connects fast (~300 ms) but the agent's first
        // frame can lag by 1-2 s on cold start; 12 s is a generous cap.
        const noTrackTimer = setTimeout(() => {
          if (!cancelled && status !== 'live' && !trackRef.current) {
            setStatus('failed');
            setErrorMsg('agent did not publish video within 12 s');
          }
        }, 12_000);
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
    const h = handleRef.current;
    handleRef.current = null;
    if (h) await h.leave();
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
              <option key={a.id} value={a.id}>
                {a.agent_name} ({a.machine_name ?? '—'})
              </option>
            ))}
          </select>
          {selectedId && (
            <button
              onClick={() => setSelectedId(null)}
              className="px-2.5 py-1.5 text-xs rounded-md bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/15"
            >Stop</button>
          )}
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${
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
                <div>fps: <span className="text-white">{stats.fps}</span> · {stats.width}×{stats.height}</div>
                <div>bytes: <span className="text-white">{stats.bitrate.toLocaleString()}</span></div>
              </div>
            )}
            {status === 'connecting' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <p className="text-sm text-amber-300">Connecting to agent…</p>
              </div>
            )}
            {status === 'failed' && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <p className="text-sm text-rose-300">{errorMsg ?? 'Connection failed'}</p>
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
              <p className="text-[11px] text-gray-600 mt-1">Requires the agent on v0.2.52+ with Screen Recording permission granted.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
