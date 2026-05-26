import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgents } from '@/lib/dataHooks';
import { connectToAgent, ConnectionState, type RoomHandle, type RemoteTrack } from '@/lib/livekit-client';

// LiveKit-powered Live tab. Replaces the ~290-line hand-rolled WebRTC
// signaling / ICE / SDP code with a 30-line connect-and-render path —
// LiveKit's SDK owns every WebRTC quirk we were debugging release after
// release. The agent publishes its screen into room `agent_<agent_id>`;
// this tab joins, subscribes to the video track, and binds it to a
// <video> element.

export default function LiveTab() {
  const { agents } = useAgents();
  const onlineAgents = useMemo(() => agents.filter((a) => a.status !== 'offline'), [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'failed'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handleRef = useRef<RoomHandle | null>(null);

  useEffect(() => {
    if (!selectedId) return;
    setStatus('connecting');
    setErrorMsg(null);
    let cancelled = false;

    const attach = (track: RemoteTrack) => {
      const v = videoRef.current;
      if (!v || cancelled) return;
      track.attach(v);
      // The agent publishes muted (no audio). Force play in case
      // autoplay heuristics waited for a user gesture.
      v.muted = true;
      v.playsInline = true;
      void v.play().catch(() => { /* gesture-blocked — user can click */ });
    };

    (async () => {
      try {
        const h = await connectToAgent({
          agentId: selectedId,
          onVideoTrack: attach,
          onState: (state) => {
            if (cancelled) return;
            if (state === ConnectionState.Connected) setStatus('live');
            else if (state === ConnectionState.Disconnected) setStatus('idle');
            else if (state === ConnectionState.Reconnecting) setStatus('connecting');
          },
        });
        if (cancelled) {
          void h.close();
          return;
        }
        handleRef.current = h;
      } catch (e) {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
      void handleRef.current?.close();
      handleRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [selectedId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
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
            autoPlay
            playsInline
            muted
            className="w-full h-full object-contain bg-black"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-center">
            <div>
              <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
                <i className="ri-broadcast-line text-3xl" />
              </span>
              <p className="text-sm text-gray-400">Select an online agent to start the live stream.</p>
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
