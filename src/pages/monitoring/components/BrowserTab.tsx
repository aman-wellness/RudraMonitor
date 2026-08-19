import { useCallback, useMemo, useState } from 'react';
import { useActivityLogs, useAgents, useProductivityRules, classify } from '@/lib/dataHooks';
import CategoryBadge from '@/components/feature/CategoryBadge';
import MonitorFilters, { type CategoryFilter } from './MonitorFilters';
import { useRegisterRefresh } from './refreshBus';
import { formatDurationShort } from '@/lib/labels';
import { Bar } from '@/pages/dashboard/components/ui';
import { C } from '@/pages/dashboard/components/chartKit';

// Best-effort: window titles aren't true URLs. Pull a domain-like substring if present, otherwise
// fall back to the full title so the row is still meaningful.
const extractHost = (title: string | null): string => {
  if (!title) return '—';
  const m = title.match(/(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)/i);
  return m?.[1] ?? title.slice(0, 60);
};

export default function BrowserTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [catFilter, setCatFilter] = useState<CategoryFilter>('all');
  const [search, setSearch] = useState('');

  const [limit, setLimit] = useState(200);
  const { rows, loading, refresh } = useActivityLogs({ type: 'browser', agentId: agentFilter, sinceHours: 24, limit });
  const hasMore = rows.length >= limit;
  const { ruleMap, upsertRule } = useProductivityRules();
  useRegisterRefresh(useCallback(() => { void refresh(); }, [refresh]));

  const aggregated = useMemo(() => {
    const map = new Map<string, {
      key: string;
      url: string;
      pageTitle: string;
      agentId: string;
      agentName: string;
      timeSpentSec: number;
      visits: number;
      lastVisit: string;
      category: 'productive' | 'unproductive' | 'neutral';
    }>();
    for (const r of rows) {
      const host = extractHost(r.url);
      const key = `${r.agent_id}::${host}`;
      const existing = map.get(key);
      const dur = r.duration ?? 0;
      if (existing) {
        existing.timeSpentSec += dur;
        existing.visits += 1;
        if (r.created_at > existing.lastVisit) {
          existing.lastVisit = r.created_at;
          existing.pageTitle = r.url ?? existing.pageTitle;
        }
      } else {
        map.set(key, {
          key,
          url: host,
          pageTitle: r.url ?? '',
          agentId: r.agent_id,
          agentName: r.agent_name,
          timeSpentSec: dur,
          visits: 1,
          lastVisit: r.created_at,
          category: classify(ruleMap, 'host', host),
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.timeSpentSec - a.timeSpentSec);
  }, [rows, ruleMap]);

  const filtered = aggregated.filter((log) => {
    const matchCat = catFilter === 'all' || log.category === catFilter;
    const matchSearch =
      search === '' ||
      log.url.toLowerCase().includes(search.toLowerCase()) ||
      log.pageTitle.toLowerCase().includes(search.toLowerCase()) ||
      log.agentName.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const longest = Math.max(1, ...filtered.map((f) => f.timeSpentSec));
  // The "page title" column showed r.url — the same string the Site column is
  // derived from, so "reddit.com | https://reddit.com/r/x" on every row. Only
  // worth its width when it carries something the host doesn't already say.
  const hasPath = filtered.some((f) => {
    const t = f.pageTitle.trim();
    return t && t !== f.url && t.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') !== f.url;
  });

  const showBar = !hasPath;

  const formatLast = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-2.5">
      <MonitorFilters
        agents={agents}
        agentFilter={agentFilter}
        onAgentChange={setAgentFilter}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Site, page, employee…"
        category={catFilter}
        onCategoryChange={setCatFilter}
        count={
          filtered.length > 0 ? (
            <span className="text-[10.5px] t3 tnum">
              {filtered.length} of {aggregated.length}
            </span>
          ) : null
        }
      />

      <div className="panel overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center">
            <i className="ri-global-line text-[22px] t3 block mb-2" />
            <p className="text-[12.5px] t2">
              {rows.length === 0 ? 'No browser activity in the last 24 hours' : 'Nothing matches these filters'}
            </p>
            {rows.length === 0 && (
              <p className="text-[11px] t3 mt-1">
                Rows appear as soon as an agent reports a browser tab.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="d-table" style={{ minWidth: 680 }}>
              <thead>
                <tr className="hair-b">
                  <th style={{ width: hasPath ? '20%' : 190 }}>Site</th>
                  {hasPath && <th>Page</th>}
                  <th style={{ width: 150 }}>Employee</th>
                  <th style={{ width: 122 }}>Category</th>
                  <th className="text-right" style={showBar ? undefined : { width: 96 }}>Time (24h)</th>
                  <th className="text-right" style={{ width: 56 }}>Visits</th>
                  <th className="text-right" style={{ width: 74 }}>Last</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log) => (
                  <tr key={log.key}>
                    <td className="text-[12px] t1 font-medium truncate max-w-[220px]" title={log.url}>
                      {log.url}
                    </td>
                    {hasPath && (
                      <td className="max-w-[300px]">
                        <span className="text-[11px] t3 truncate block" title={log.pageTitle}>
                          {log.pageTitle || '—'}
                        </span>
                      </td>
                    )}
                    <td className="text-[11.5px] t2 truncate">{log.agentName || 'Unknown'}</td>
                    <td>
                      <CategoryBadge
                        value={log.category}
                        onChange={(c) => upsertRule('host', log.url, c)}
                      />
                    </td>
                    <td>
                      <span className="flex items-center gap-2.5 justify-end">
                        {showBar && (
                          <span className="flex-1 min-w-[60px] hidden md:block">
                            <Bar pct={(log.timeSpentSec / longest) * 100} height={4} color={C.accent} />
                          </span>
                        )}
                        <span className="text-[11.5px] t2 tnum text-right w-[52px]">
                          {formatDurationShort(log.timeSpentSec)}
                        </span>
                      </span>
                    </td>
                    <td className="text-right text-[11.5px] t3 tnum">{log.visits}</td>
                    <td className="text-right text-[11px] t3 whitespace-nowrap tnum">
                      {formatLast(log.lastVisit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <button onClick={() => setLimit((l) => l + 200)} className="chip chip-quiet text-[10.5px]">
            <i className="ri-arrow-down-line" />
            Load more
          </button>
        </div>
      )}
      {loading && filtered.length === 0 && (
        <p className="text-center text-[11px] t3 py-3">Loading…</p>
      )}
    </div>
  );
}
