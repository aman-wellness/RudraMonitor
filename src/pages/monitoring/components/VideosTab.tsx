import { useCallback, useMemo, useState } from 'react';
import { useActivityLogs, useAgents, useSignedVideoUrls, type UiAgent } from '@/lib/dataHooks';
import MonitorFilters from './MonitorFilters';
import { useRegisterRefresh } from './refreshBus';
import { formatDurationShort } from '@/lib/labels';
import Pagination, { usePagination } from './Pagination';

/* Recorded clips, last 72h. */
const cadence = (agents: UiAgent[]) => {
  const values = Array.from(
    new Set(agents.map((a) => a.videoIntervalSecs).filter((v): v is number => typeof v === 'number' && v > 0)),
  ).sort((a, b) => a - b);
  if (values.length === 0) return 'Enable Video Recording on an agent from its Capture controls.';
  if (values.length === 1) return `Agents with recording enabled clip every ${formatDurationShort(values[0])}.`;
  return `Agents clip every ${formatDurationShort(values[0])} to ${formatDurationShort(values[values.length - 1])}.`;
};

export default function VideosTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { rows, loading, refresh } = useActivityLogs({ type: 'video', agentId: agentFilter, sinceHours: 72, limit: 200 });
  useRegisterRefresh(useCallback(() => { void refresh(); }, [refresh]));

  const filtered = useMemo(
    () => rows.filter((v) =>
      search === '' || (v.agent_name ?? '').toLowerCase().includes(search.toLowerCase())
    ),
    [rows, search],
  );

  // 12 per page — four rows of the three-column grid.
  const { visible, page, pageCount, setPage, from, to, total } = usePagination(filtered, 12);

  // Sign only the CURRENT PAGE. Clips are far heavier than screenshots, so
  // signing all 200 fetched rows up front meant 200 signing requests and a
  // browser holding 200 video sources for a grid showing a dozen. Filtering and
  // paging therefore have to happen before signing, not after.
  const paths = useMemo(
    () => visible.map((r) => r.video_url).filter((p): p is string => !!p),
    [visible],
  );
  const signed = useSignedVideoUrls(paths);

  const stamp = (iso: string) => {
    try { return new Date(iso).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };

  return (
    <div className="space-y-2.5">
      <MonitorFilters
        agents={agents}
        agentFilter={agentFilter}
        onAgentChange={setAgentFilter}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Agent…"
        count={
          filtered.length > 0 ? (
            <span className="text-[10.5px] t3 tnum">{filtered.length} of {rows.length}</span>
          ) : null
        }
      />

      {filtered.length === 0 ? (
        <div className="panel p-8 text-center">
          <i className="ri-video-line text-[22px] t3 block mb-2" />
          <p className="text-[12.5px] t2">
            {rows.length === 0 ? 'No clips in the last 72 hours' : 'Nothing matches these filters'}
          </p>
          {rows.length === 0 && <p className="text-[11px] t3 mt-1">{cadence(agents)}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {visible.map((v) => {
            const url = v.video_url ? signed[v.video_url] : null;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setPreviewId(v.id)}
                className="group sunken rounded-lg overflow-hidden text-left tile-media"
              >
                <div className="relative aspect-video">
                  {url ? (
                    <video src={url} className="w-full h-full object-cover" muted preload="metadata" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center t3">
                      <i className="ri-video-line text-[20px]" />
                    </div>
                  )}
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ background: 'rgba(0,0,0,0.35)' }}>
                    <i className="ri-play-fill text-white text-[22px]" />
                  </span>
                  {/* Only when the row actually carries a duration — this used to
                      print "10s" as a fallback, inventing a length for clips
                      whose duration the agent never reported. */}
                  {typeof v.duration === 'number' && v.duration > 0 && (
                    <span
                      className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] text-white tnum"
                      style={{ background: 'rgba(0,0,0,0.7)' }}
                    >
                      {formatDurationShort(v.duration)}
                    </span>
                  )}
                </div>
                <div className="px-2.5 py-2 flex items-center justify-between gap-2">
                  <span className="text-[11.5px] t1 truncate">{v.agent_name || 'Unknown'}</span>
                  <span className="text-[10px] t3 tnum whitespace-nowrap">{stamp(v.created_at)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Pagination
        page={page} pageCount={pageCount} from={from} to={to} total={total}
        onPage={setPage} unit="clips"
      />

      {loading && filtered.length === 0 && (
        <p className="text-center text-[11px] t3 py-3">Loading…</p>
      )}

      {previewId && (() => {
        const v = rows.find((r) => r.id === previewId);
        if (!v) return null;
        const url = v.video_url ? signed[v.video_url] : null;
        return (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.82)' }}
            onClick={() => setPreviewId(null)}
          >
            <div className="max-w-4xl w-full" onClick={(e) => e.stopPropagation()}>
              <div className="rounded-xl overflow-hidden" style={{ background: 'var(--d-panel)' }}>
                <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 hair-b">
                  <div className="min-w-0">
                    <p className="text-[12.5px] t1 truncate">{v.agent_name || 'Unknown'}</p>
                    <p className="text-[10.5px] t3">
                      {stamp(v.created_at)}
                      {typeof v.duration === 'number' && v.duration > 0 && ` · ${formatDurationShort(v.duration)}`}
                    </p>
                  </div>
                  <button onClick={() => setPreviewId(null)} className="icon-btn" aria-label="Close">
                    <i className="ri-close-line" />
                  </button>
                </div>
                {url ? (
                  <video src={url} controls autoPlay className="w-full" style={{ maxHeight: '78vh' }} />
                ) : (
                  <div className="h-64 flex items-center justify-center text-[11px] t3">Loading…</div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
