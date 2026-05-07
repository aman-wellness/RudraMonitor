import { useMemo, useState } from 'react';
import { useActivityLogs, useAgents, useSignedScreenshotUrls } from '@/lib/dataHooks';

export default function ScreenshotsTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [triggerFilter, setTriggerFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { rows, loading } = useActivityLogs({ type: 'screenshot', agentId: agentFilter, sinceHours: 72, limit: 200 });

  const paths = useMemo(
    () => rows.map((r) => r.screenshot_url).filter((p): p is string => !!p),
    [rows],
  );
  const signed = useSignedScreenshotUrls(paths);

  const filtered = rows.filter((ss) => {
    const trigger = ss.url ?? 'interval';
    const matchTrigger = triggerFilter === 'all' || trigger === triggerFilter;
    const matchSearch = search === '' || (ss.url ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (ss.agent_name ?? '').toLowerCase().includes(search.toLowerCase());
    return matchTrigger && matchSearch;
  });

  // Triggers come from the `url` column on screenshot rows ("interval" or future categories).
  const triggers = ['all', ...Array.from(new Set(rows.map((r) => r.url ?? 'interval')))];

  const formatTime = (iso: string) => {
    try { return new Date(iso).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {triggers.map((t) => (
            <button
              key={t}
              onClick={() => setTriggerFilter(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                triggerFilter === t ? 'bg-dark-700 text-white' : 'text-gray-500 hover:text-gray-400 bg-dark-800'
              }`}
            >
              {t === 'all' ? 'All Triggers' : t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none"
          >
            <option value="all">All Agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5">
            <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
              <i className="ri-search-line text-sm" />
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search screenshots..."
              className="bg-transparent text-xs text-white placeholder-gray-600 focus:outline-none w-32 md:w-40"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map((ss) => {
          const url = ss.screenshot_url ? signed[ss.screenshot_url] : null;
          return (
            <div key={ss.id} className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden group">
              <div
                className="relative aspect-video bg-dark-900 cursor-pointer overflow-hidden"
                onClick={() => setPreviewId(ss.id)}
              >
                {url ? (
                  <img
                    src={url}
                    alt={`Screenshot ${ss.created_at}`}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">
                    <i className="ri-image-line text-2xl" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                  <span className="opacity-0 group-hover:opacity-100 transition-opacity w-8 h-8 flex items-center justify-center rounded-full bg-white/90">
                    <i className="ri-zoom-in-line text-dark-900 text-sm" />
                  </span>
                </div>
                <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/70 rounded text-[10px] text-white font-medium">
                  {ss.url ?? 'interval'}
                </div>
                <div className="absolute bottom-2 right-2 px-2 py-0.5 bg-black/70 rounded text-[10px] text-white font-medium">
                  {formatTime(ss.created_at)}
                </div>
              </div>
              <div className="p-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm text-white font-medium">{ss.agent_name || 'Unknown'}</p>
                </div>
                <p className="text-xs text-gray-400 truncate">{ss.url ?? 'Periodic capture'}</p>
              </div>
            </div>
          );
        })}
      </div>

      {!loading && filtered.length === 0 && (
        <div className="text-center py-12">
          <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
            <i className="ri-image-line text-3xl" />
          </span>
          <p className="text-sm text-gray-500">
            {rows.length === 0 ? 'No screenshots yet — agents capture every 5 minutes.' : 'No screenshots match your filters'}
          </p>
        </div>
      )}
      {loading && filtered.length === 0 && (
        <div className="text-center py-12 text-xs text-gray-500">Loading…</div>
      )}

      {previewId && (() => {
        const ss = rows.find((s) => s.id === previewId);
        if (!ss) return null;
        const url = ss.screenshot_url ? signed[ss.screenshot_url] : null;
        return (
          <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={() => setPreviewId(null)}>
            <div className="max-w-4xl w-full" onClick={(e) => e.stopPropagation()}>
              <div className="bg-dark-800 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700">
                  <div>
                    <p className="text-sm text-white font-medium">{ss.agent_name}</p>
                    <p className="text-xs text-gray-500">{ss.url ?? 'interval'} at {formatTime(ss.created_at)}</p>
                  </div>
                  <button onClick={() => setPreviewId(null)} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white">
                    <i className="ri-close-line text-lg" />
                  </button>
                </div>
                {url ? (
                  <img src={url} alt="Screenshot preview" className="w-full object-contain" />
                ) : (
                  <div className="h-64 flex items-center justify-center text-gray-500 text-xs">Loading…</div>
                )}
                {url && (
                  <div className="px-4 py-3 border-t border-dark-700 flex items-center justify-between">
                    <span className="text-xs text-gray-500">Trigger: {ss.url ?? 'interval'}</span>
                    <a
                      href={url}
                      download={`screenshot-${ss.id}.jpg`}
                      className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                    >
                      <span className="w-3 h-3 flex items-center justify-center"><i className="ri-download-line" /></span>
                      Download
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
