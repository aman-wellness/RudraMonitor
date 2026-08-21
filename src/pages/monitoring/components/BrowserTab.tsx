import { useCallback, useMemo, useState } from 'react';
import {
  useBrowserUsage, useAgents, useProductivityRules, classify, isDepartmentOverridden,
} from '@/lib/dataHooks';
import CategoryBadge from '@/components/feature/CategoryBadge';
import MonitorFilters, { type CategoryFilter } from './MonitorFilters';
import { useRegisterRefresh } from './refreshBus';
import { formatDurationShort } from '@/lib/labels';
import { Bar } from '@/pages/dashboard/components/ui';
import { C } from '@/pages/dashboard/components/chartKit';
import Pagination, { usePagination } from './Pagination';

/* Hosts are grouped and titles resolved by org_browser_usage (migration 0131).
   The client used to do this over a limited slice of raw rows, which truncated
   the list, and it displayed `url` in the page column because
   activity_logs.page_title was never fetched — so a Google search rendered as
   ~300 characters of tracking parameters instead of its title. */

export default function BrowserTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [catFilter, setCatFilter] = useState<CategoryFilter>('all');
  const [search, setSearch] = useState('');

  const { rows, loading, refresh } = useBrowserUsage({ agentId: agentFilter, sinceHours: 24 });
  const { ruleMap, upsertRule } = useProductivityRules();
  useRegisterRefresh(useCallback(() => { void refresh(); }, [refresh]));

  const aggregated = useMemo(
    () => rows.map((r) => ({
      // Rows are per PAGE now, so the host alone is no longer unique — several
      // searches share one host and React would see duplicate keys.
      key: `${r.agent_id}::${r.host}::${r.page_title}`,
      url: r.host,
      pageTitle: r.page_title ?? '',
      lastUrl: r.last_url ?? '',
      agentId: r.agent_id,
      agentName: r.agent_name,
      department: r.department,
      timeSpentSec: r.total_seconds,
      visits: r.visits,
      lastVisit: r.last_visit,
      category: classify(ruleMap, 'host', r.host, r.department),
      overridden: isDepartmentOverridden(ruleMap, 'host', r.host, r.department),
    })),
    [rows, ruleMap],
  );

  // Constant across rows; reported under the table rather than folded in as an
  // unnamed group, which used to outrank every real site.
  const unresolvedSamples = rows[0]?.unresolved_samples ?? 0;
  const unresolvedSeconds = rows[0]?.unresolved_seconds ?? 0;

  const filtered = useMemo(() => aggregated.filter((log) => {
    const matchCat = catFilter === 'all' || log.category === catFilter;
    const matchSearch =
      search === '' ||
      log.url.toLowerCase().includes(search.toLowerCase()) ||
      log.pageTitle.toLowerCase().includes(search.toLowerCase()) ||
      log.agentName.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  }), [aggregated, catFilter, search]);

  const { visible, page, pageCount, setPage, from, to, total } = usePagination(filtered);

  // Scale the bar against the widest row ON THIS PAGE, so the comparison stays
  // meaningful after paging rather than every bar on page 4 being a stub.
  const longest = Math.max(1, ...visible.map((f) => f.timeSpentSec));
  const hasPath = visible.some((f) => f.pageTitle.trim());

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
        searchPlaceholder="Site, page, agent…"
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
                  <th style={{ width: 150 }}>Agent</th>
                  <th style={{ width: 122 }}>Category</th>
                  <th className="text-right" style={showBar ? undefined : { width: 96 }}>Time (24h)</th>
                  <th className="text-right" style={{ width: 56 }}>Visits</th>
                  <th className="text-right" style={{ width: 74 }}>Last</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((log) => (
                  <tr key={log.key}>
                    <td className="text-[12px] t1 font-medium truncate max-w-[220px]" title={log.lastUrl || log.url}>
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
                      <span className="flex items-center gap-1">
                        <CategoryBadge
                          value={log.category}
                          onChange={(c) => upsertRule('host', log.url, c)}
                        />
                        {/* This control edits the all-departments default, so
                            say when a department rule is what's deciding the
                            row — otherwise changing it looks like a no-op. */}
                        {log.overridden && (
                          <i
                            className="ri-information-line text-[11px] t3"
                            title={`Set by a ${log.department} department rule. Edit it in Admin Portal → Applications; this control changes the all-departments default.`}
                          />
                        )}
                      </span>
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

      <Pagination
        page={page} pageCount={pageCount} from={from} to={to} total={total}
        onPage={setPage} unit="pages"
      />

      {unresolvedSamples > 0 && (
        <p className="text-[10.5px] t3 text-center">
          {unresolvedSamples} sample{unresolvedSamples === 1 ? '' : 's'} ({formatDurationShort(unresolvedSeconds)})
          had no readable address bar and are not attributed to a page above.
        </p>
      )}

      {loading && filtered.length === 0 && (
        <p className="text-center text-[11px] t3 py-3">Loading…</p>
      )}
    </div>
  );
}
