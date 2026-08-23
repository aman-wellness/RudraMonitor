import { useCallback, useMemo, useState } from 'react';
import {
  useAppUsage, useAgents, useProductivityRules, classify, isDepartmentOverridden,
} from '@/lib/dataHooks';
import CategoryBadge from '@/components/feature/CategoryBadge';
import MonitorFilters, { type CategoryFilter } from './MonitorFilters';
import { useRegisterRefresh } from './refreshBus';
import { formatDurationShort } from '@/lib/labels';
import { Bar } from '@/pages/dashboard/components/ui';
import { C } from '@/pages/dashboard/components/chartKit';
import Pagination, { usePagination } from './Pagination';

/* Foreground application time per agent, last 24h.

   Was a grid of one card per (app × employee) pair: 120px tall each, holding an
   app name, a person, an always-empty window-title line, a duration and a
   timestamp. Five employees using six apps produced 30 near-identical cards and
   a 1700px page you had to scroll to compare any two numbers. A table puts the
   same rows in a fifth of the height with the durations in one column, which is
   the only way to read a ranking. */

export default function ApplicationsTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [catFilter, setCatFilter] = useState<CategoryFilter>('all');
  const [search, setSearch] = useState('');

  // Aggregated in SQL (org_app_usage). The previous version pulled raw rows
  // with a limit and grouped them here, which meant the limit bounded SAMPLES
  // rather than applications: one busy app could fill the page and hide every
  // other app the employee used, while the header still claimed the list was
  // complete. See migration 0130.
  const { rows, loading, refresh } = useAppUsage({ agentId: agentFilter, sinceHours: 24 });
  const { ruleMap, upsertRule } = useProductivityRules();
  useRegisterRefresh(useCallback(() => { void refresh(); }, [refresh]));

  const aggregated = useMemo(
    () => rows.map((r) => ({
      key: `${r.agent_id}::${r.application_name}`,
      appName: r.application_name,
      windowTitle: r.window_title ?? '',
      agentId: r.agent_id,
      agentName: r.agent_name,
      department: r.department,
      duration: r.total_seconds,
      lastActive: r.last_seen,
      // Classified from the agent's own department, so an app that is
      // productive for one team and unproductive for another reads correctly
      // per row — and matches what the productivity RPC computes.
      category: classify(ruleMap, 'app', r.application_name, r.department),
      overridden: isDepartmentOverridden(ruleMap, 'app', r.application_name, r.department),
    })),
    [rows, ruleMap],
  );

  const filtered = useMemo(() => aggregated.filter((log) => {
    const matchCat = catFilter === 'all' || log.category === catFilter
      || (catFilter === 'unproductive' && log.category === 'prohibited');
    const matchSearch =
      search === '' ||
      log.appName.toLowerCase().includes(search.toLowerCase()) ||
      log.windowTitle.toLowerCase().includes(search.toLowerCase()) ||
      log.agentName.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  }), [aggregated, catFilter, search]);

  const { visible, page, pageCount, setPage, from, to, total } = usePagination(filtered);

  // Longest row ON THIS PAGE — the bar is relative to it, so the duration
  // column reads as a ranking instead of a list of numbers to compare by eye.
  // Scoped to the page so bars stay comparable after paging.
  const longest = Math.max(1, ...visible.map((f) => f.duration));
  // A window title is only worth a column if the agents actually captured one.
  const hasTitles = visible.some((f) => f.windowTitle.trim());

  const showBar = !hasTitles;

  const formatTime = (iso: string) => {
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
        searchPlaceholder="App, window title, agent…"
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
            <i className="ri-apps-line text-[22px] t3 block mb-2" />
            <p className="text-[12.5px] t2">
              {rows.length === 0 ? 'No application activity in the last 24 hours' : 'Nothing matches these filters'}
            </p>
            {rows.length === 0 && (
              <p className="text-[11px] t3 mt-1">
                Rows appear as soon as an agent reports a foreground window.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="d-table" style={{ minWidth: 640 }}>
              <thead>
                <tr className="hair-b">
                  <th style={{ width: hasTitles ? '22%' : 200 }}>Application</th>
                  {hasTitles && <th>Window</th>}
                  <th style={{ width: 150 }}>Agent</th>
                  <th style={{ width: 122 }}>Category</th>
                  <th className="text-right" style={showBar ? undefined : { width: 96 }}>Time (24h)</th>
                  <th className="text-right" style={{ width: 74 }}>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((log) => (
                  <tr key={log.key}>
                    <td className="text-[12px] t1 font-medium truncate max-w-[240px]" title={log.appName}>
                      {log.appName}
                    </td>
                    {hasTitles && (
                      <td className="max-w-[300px]">
                        <span className="text-[11px] t3 truncate block" title={log.windowTitle}>
                          {log.windowTitle || '—'}
                        </span>
                      </td>
                    )}
                    <td className="text-[11.5px] t2 truncate">{log.agentName || 'Unknown'}</td>
                    <td>
                      <span className="flex items-center gap-1">
                        <CategoryBadge
                          value={log.category}
                          onChange={(c) => upsertRule('app', log.appName, c)}
                        />
                        {/* This control edits the organisation-wide default. If
                            a department override is what's actually deciding
                            this row, changing it here would appear to do
                            nothing, so say where the value comes from. */}
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
                            <Bar pct={(log.duration / longest) * 100} height={4} color={C.accent} />
                          </span>
                        )}
                        <span className="text-[11.5px] t2 tnum text-right w-[52px]">
                          {formatDurationShort(log.duration)}
                        </span>
                      </span>
                    </td>
                    <td className="text-right text-[11px] t3 whitespace-nowrap tnum">
                      {formatTime(log.lastActive)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* org_app_usage returns every application in the window, so paging is a
          pure view concern and the total below is the real total — unlike the
          old "Load more", whose counter described only what had been fetched. */}
      <Pagination
        page={page} pageCount={pageCount} from={from} to={to} total={total}
        onPage={setPage} unit="applications"
      />

      {loading && filtered.length === 0 && (
        <p className="text-center text-[11px] t3 py-3">Loading…</p>
      )}
    </div>
  );
}
