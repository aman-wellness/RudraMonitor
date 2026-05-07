import { useMemo, useState } from 'react';
import { useActivityLogs, useAgents, useSignedVideoUrls } from '@/lib/dataHooks';

export default function VideosTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { rows, loading } = useActivityLogs({ type: 'video', agentId: agentFilter, sinceHours: 72, limit: 200 });
  const paths = useMemo(
    () => rows.map((r) => r.video_url).filter((p): p is string => !!p),
    [rows],
  );
  const signed = useSignedVideoUrls(paths);

  const filtered = rows.filter((v) =>
    search === '' || (v.agent_name ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const formatTime = (iso: string) => {
    try { return new Date(iso).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none"
          >
            <option value="all">All Agents</option>
            {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
          </select>
        </div>
        <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5">
          <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
            <i className="ri-search-line text-sm" />
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by agent..."
            className="bg-transparent text-xs text-white placeholder-gray-600 focus:outline-none w-32 md:w-40"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((v) => {
          const url = v.video_url ? signed[v.video_url] : null;
          return (
            <div key={v.id} className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden group">
              <div
                className="relative aspect-video bg-dark-900 cursor-pointer overflow-hidden"
                onClick={() => setPreviewId(v.id)}
              >
                {url ? (
                  <video src={url} className="w-full h-full object-cover" muted preload="metadata" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600">
                    <i className="ri-video-line text-2xl" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity w-10 h-10 flex items-center justify-center rounded-full bg-white/90">
                    <i className="ri-play-fill text-dark-900 text-lg" />
                  </span>
                </div>
                <div className="absolute bottom-2 right-2 px-2 py-0.5 bg-black/70 rounded text-[10px] text-white font-medium">
                  {v.duration ?? 10}s
                </div>
              </div>
              <div className="p-3">
                <p className="text-sm text-white font-medium">{v.agent_name || 'Unknown'}</p>
                <p className="text-[11px] text-gray-500">{formatTime(v.created_at)}</p>
              </div>
            </div>
          );
        })}
      </div>

      {!loading && filtered.length === 0 && (
        <div className="text-center py-12">
          <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
            <i className="ri-video-line text-3xl" />
          </span>
          <p className="text-sm text-gray-500">
            {rows.length === 0
              ? 'No video clips yet. Enable "Video Recording" on an agent and ensure ffmpeg is installed.'
              : 'No clips match your filters'}
          </p>
        </div>
      )}
      {loading && filtered.length === 0 && (
        <div className="text-center py-12 text-xs text-gray-500">Loading…</div>
      )}

      {previewId && (() => {
        const v = rows.find((r) => r.id === previewId);
        if (!v) return null;
        const url = v.video_url ? signed[v.video_url] : null;
        return (
          <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={() => setPreviewId(null)}>
            <div className="max-w-4xl w-full" onClick={(e) => e.stopPropagation()}>
              <div className="bg-dark-800 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
                  <div>
                    <p className="text-sm text-white font-medium">{v.agent_name}</p>
                    <p className="text-xs text-gray-500">{formatTime(v.created_at)} · {v.duration ?? 10}s</p>
                  </div>
                  <button onClick={() => setPreviewId(null)} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white">
                    <i className="ri-close-line text-lg" />
                  </button>
                </div>
                {url ? (
                  <video src={url} controls autoPlay className="w-full" />
                ) : (
                  <div className="h-64 flex items-center justify-center text-gray-500 text-xs">Loading…</div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
