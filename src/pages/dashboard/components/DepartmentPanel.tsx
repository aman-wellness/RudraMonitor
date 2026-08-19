import { useMemo } from 'react';
import { useAgents, useProductivityPerAgent } from '@/lib/dataHooks';
import { useRefreshOnTick } from '../refreshBus';
import { useFilterWindow } from '../filterContext';
import { Bar, EmptyNote, Panel } from './ui';
import { C, formatHm } from './chartKit';

/* Ranked horizontal bars, one row per department.

   The page already shows a fleet average and a per-agent table; neither
   answers "which team is the outlier". Grouping by department does, and it's
   the level an owner can act on. Departments with no rule-matched time show
   "—" rather than 0% — unmeasured and zero mean very different things. */

export default function DepartmentPanel({ index = 0 }: { index?: number }) {
  const w = useFilterWindow();
  const { agents: allAgents, refresh: refreshAgents } = useAgents();
  const { byAgent, refresh: refreshSplit } = useProductivityPerAgent(w.sinceHours, w.untilHours);
  const agents = useMemo(
    () => (w.agentId ? allAgents.filter((a) => a.id === w.agentId) : allAgents),
    [allAgents, w.agentId],
  );
  useRefreshOnTick(refreshAgents, refreshSplit);

  const rows = useMemo(() => {
    const groups = new Map<
      string,
      { headcount: number; active: number; productive: number; unproductive: number; online: number }
    >();
    for (const a of agents) {
      const key = a.department || 'Unassigned';
      const g =
        groups.get(key) ?? { headcount: 0, active: 0, productive: 0, unproductive: 0, online: 0 };
      g.headcount += 1;
      if (a.status === 'online' || a.status === 'idle') g.online += 1;
      const agg = byAgent[a.id];
      if (agg) {
        g.active += agg.active_seconds;
        g.productive += agg.weighted_seconds;
        g.unproductive += agg.unproductive_seconds;
      }
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([name, g]) => {
        const matched = g.productive + g.unproductive;
        return {
          name,
          headcount: g.headcount,
          online: g.online,
          avgSeconds: g.headcount > 0 ? g.active / g.headcount : 0,
          pct: matched > 0 ? Math.round((g.productive / matched) * 100) : null,
        };
      })
      .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.headcount - a.headcount);
  }, [agents, byAgent]);

  const measured = rows.filter((r) => r.pct !== null);
  const fleetAvg =
    measured.length > 0
      ? Math.round(measured.reduce((s, r) => s + (r.pct ?? 0), 0) / measured.length)
      : null;

  return (
    <Panel title="By department" hint={w.label} index={index}>
      {rows.length === 0 ? (
        <EmptyNote title="No agents enrolled yet" />
      ) : (
        <>
          <div className="flex-1 flex flex-col justify-between gap-2">
            {rows.slice(0, 6).map((r) => {
              const color =
                r.pct === null
                  ? C.neutral
                  : r.pct >= 80
                    ? C.success
                    : r.pct >= 55
                      ? C.accent
                      : C.warning;
              return (
                <div key={r.name} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="text-[11px] t2 truncate" title={r.name}>
                      {r.name}
                    </span>
                    <span
                      className={`text-[11px] tnum flex-shrink-0 ${
                        r.pct === null ? 't3' : 't1 font-medium'
                      }`}
                    >
                      {r.pct === null ? '—' : `${r.pct}%`}
                    </span>
                  </div>
                  <Bar pct={r.pct ?? 0} color={color} height={4} />
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-[9.5px] t3">
                      {r.headcount} agent{r.headcount === 1 ? '' : 's'}
                      {r.online > 0 && <span className="t-success"> · {r.online} live</span>}
                    </span>
                    <span className="text-[9.5px] t3 tnum">{formatHm(r.avgSeconds)} avg</span>
                  </div>
                </div>
              );
            })}
          </div>

          {fleetAvg !== null && (
            <p className="text-[9.5px] t3 mt-auto pt-2.5 hair-t">
              Fleet average {fleetAvg}%
              {rows.length > 6
                ? ` · ${rows.length - 6} more department${rows.length - 6 === 1 ? '' : 's'}`
                : ''}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
