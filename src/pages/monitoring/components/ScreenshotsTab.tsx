import { useCallback, useMemo, useState } from 'react';
import { useActivityLogs, useAgents, useSignedScreenshotUrls, type UiAgent } from '@/lib/dataHooks';
import MonitorFilters from './MonitorFilters';
import { useRegisterRefresh } from './refreshBus';
import { formatDurationShort, prettyKind } from '@/lib/labels';
import Pagination, { usePagination } from './Pagination';

/* Screenshot wall, last 72h.

   The empty state used to read "agents capture every 5 minutes". The cadence is
   per agent (agents.screenshot_interval_secs) and editable from the agent's
   Capture controls, so that sentence was a guess that happened to match the
   default. It now states the intervals the fleet is actually set to. */
const cadence = (agents: UiAgent[]) => {
  const values = Array.from(
    new Set(agents.map((a) => a.screenshotIntervalSecs).filter((v): v is number => typeof v === 'number' && v > 0)),
  ).sort((a, b) => a - b);
  if (values.length === 0) return 'Captures appear here once an agent reports one.';
  if (values.length === 1) return `Agents are set to capture every ${formatDurationShort(values[0])}.`;
  return `Agents are set to capture every ${formatDurationShort(values[0])} to ${formatDurationShort(values[values.length - 1])}.`;
};

export default function ScreenshotsTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [triggerFilter, setTriggerFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { rows, loading, refresh } = useActivityLogs({ type: 'screenshot', agentId: agentFilter, sinceHours: 72, limit: 200 });
  useRegisterRefresh(useCallback(() => { void refresh(); }, [refresh]));

  const filtered = useMemo(() => rows.filter((ss) => {
    const trigger = ss.url ?? 'interval';
    const matchTrigger = triggerFilter === 'all' || trigger === triggerFilter;
    const matchSearch = search === '' || (ss.url ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (ss.agent_name ?? '').toLowerCase().includes(search.toLowerCase());
    return matchTrigger && matchSearch;
  }), [rows, triggerFilter, search]);

  // 24 per page — six rows of the four-column grid.
  const { visible, page, pageCount, setPage, from, to, total } = usePagination(filtered, 24);

  // Sign only the CURRENT PAGE. This used to sign every one of the 200 fetched
  // rows on mount, so opening the tab issued 200 signing requests and asked the
  // browser to fetch 200 images at once for a grid that shows a couple of dozen.
  // Ordering matters here: paths has to be derived from `visible`, which means
  // filtering and paging must happen before signing rather than after.
  const paths = useMemo(
    () => visible.map((r) => r.screenshot_url).filter((p): p is string => !!p),
    [visible],
  );
  const signed = useSignedScreenshotUrls(paths);

  // Triggers come from the `url` column on screenshot rows ("interval" or future
  // categories) — derived, so a new trigger the agent starts sending shows up
  // as a filter on its own.
  const triggers = ['all', ...Array.from(new Set(rows.map((r) => r.url ?? 'interval')))];

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
        searchPlaceholder="Agent or trigger…"
        count={
          filtered.length > 0 ? (
            <span className="text-[10.5px] t3 tnum">{filtered.length} of {rows.length}</span>
          ) : null
        }
        leading={
          triggers.length > 1 ? (
            <div className="seg">
              {triggers.map((t) => (
                <button
                  key={t}
                  onClick={() => setTriggerFilter(t)}
                  className={`seg-btn ${triggerFilter === t ? 'is-on' : ''}`}
                >
                  {t === 'all' ? 'All triggers' : prettyKind(t)}
                </button>
              ))}
            </div>
          ) : null
        }
      />

      {filtered.length === 0 ? (
        <div className="panel p-8 text-center">
          <i className="ri-camera-line text-[22px] t3 block mb-2" />
          <p className="text-[12.5px] t2">
            {rows.length === 0 ? 'No screenshots in the last 72 hours' : 'Nothing matches these filters'}
          </p>
          {rows.length === 0 && <p className="text-[11px] t3 mt-1">{cadence(agents)}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {visible.map((ss) => {
            const url = ss.screenshot_url ? signed[ss.screenshot_url] : null;
            return (
              <button
                key={ss.id}
                type="button"
                onClick={() => setPreviewId(ss.id)}
                className="group sunken rounded-lg overflow-hidden text-left tile-media"
              >
                <div className="relative aspect-video">
                  {url ? (
                    <img src={url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center t3">
                      <i className="ri-image-line text-[20px]" />
                    </div>
                  )}
                  <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ background: 'rgba(0,0,0,0.35)' }}>
                    <i className="ri-zoom-in-line text-white text-[18px]" />
                  </span>
                </div>
                <div className="px-2.5 py-2 flex items-center justify-between gap-2">
                  <span className="text-[11.5px] t1 truncate">{ss.agent_name || 'Unknown'}</span>
                  <span className="text-[10px] t3 tnum whitespace-nowrap">{stamp(ss.created_at)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Pagination
        page={page} pageCount={pageCount} from={from} to={to} total={total}
        onPage={setPage} unit="screenshots"
      />

      {loading && filtered.length === 0 && (
        <p className="text-center text-[11px] t3 py-3">Loading…</p>
      )}

      {previewId && (() => {
        const ss = rows.find((s) => s.id === previewId);
        if (!ss) return null;
        const url = ss.screenshot_url ? signed[ss.screenshot_url] : null;
        return (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.82)' }}
            onClick={() => setPreviewId(null)}
          >
            <div className="max-w-5xl w-full" onClick={(e) => e.stopPropagation()}>
              <div className="rounded-xl overflow-hidden" style={{ background: 'var(--d-panel)' }}>
                <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 hair-b">
                  <div className="min-w-0">
                    <p className="text-[12.5px] t1 truncate">{ss.agent_name || 'Unknown'}</p>
                    <p className="text-[10.5px] t3">
                      {prettyKind(ss.url ?? 'interval')} · {stamp(ss.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {url && (
                      <a href={url} download={`screenshot-${ss.id}.jpg`} className="chip chip-quiet text-[10.5px]">
                        <i className="ri-download-line" />
                        Download
                      </a>
                    )}
                    <button onClick={() => setPreviewId(null)} className="icon-btn" aria-label="Close">
                      <i className="ri-close-line" />
                    </button>
                  </div>
                </div>
                {url ? (
                  <img src={url} alt="" className="w-full object-contain" style={{ maxHeight: '78vh' }} />
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
