import { useMemo } from 'react';
import { useProductivityRules, useTopApplications } from '@/lib/dataHooks';
import { useRefreshOnTick } from '../refreshBus';
import { useFilterWindow } from '../filterContext';
import { Bar, EmptyNote, Panel } from './ui';
import { C, formatHm } from './chartKit';

/* Where the hours actually went, coloured by the org's own productivity rules
   so it's obvious at a glance whether the top of the list is work or
   distraction. Uncategorised apps are grey on purpose — that's a prompt to add
   a rule, not a judgement. */

const LEGEND = [
  { c: C.success, l: 'productive' },
  { c: C.warning, l: 'unproductive' },
  { c: C.neutral, l: 'uncategorised' },
];

export default function TopApplications({ index = 0 }: { index?: number }) {
  const w = useFilterWindow();
  const { rows, loading, approximate, refresh } = useTopApplications(
    w.sinceHours, 12, w.untilHours, w.agentId,
  );
  const { rules } = useProductivityRules();
  useRefreshOnTick(refresh);

  // pattern → category, lower-cased, apps only.
  const category = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rules) {
      if (r.match_type === 'app') map.set(r.pattern.toLowerCase(), r.category);
    }
    return map;
  }, [rules]);

  const view = useMemo(() => {
    const total = rows.reduce((s, r) => s + r.seconds, 0);
    if (total === 0)
      return { total, items: [] as { name: string; pct: number; seconds: number; cat: string }[] };
    const top = rows.slice(0, 5);
    const rest = rows.slice(5);
    const items = top.map((r) => ({
      name: r.name,
      seconds: r.seconds,
      pct: Math.round((r.seconds / total) * 100),
      cat: category.get(r.name.toLowerCase()) ?? 'neutral',
    }));
    const restSeconds = rest.reduce((s, r) => s + r.seconds, 0);
    if (restSeconds > 0) {
      items.push({
        name: `Other (${rest.length})`,
        seconds: restSeconds,
        pct: Math.round((restSeconds / total) * 100),
        cat: 'neutral',
      });
    }
    return { total, items };
  }, [rows, category]);

  const colorFor = (cat: string) =>
    cat === 'productive' ? C.success : cat === 'unproductive' ? C.warning : C.neutral;

  return (
    <Panel title="Application time" hint={w.label} index={index}>
      {loading && view.items.length === 0 ? (
        <EmptyNote title="Loading…" />
      ) : view.items.length === 0 ? (
        <EmptyNote title="No application activity in this range" />
      ) : (
        <>
          <div>
            {view.items.map((item) => (
              <div key={item.name} className="rank-row min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-[11px] t2 truncate" title={item.name}>
                    {item.name}
                  </span>
                  <span className="text-[11px] t3 tnum flex-shrink-0">
                    {formatHm(item.seconds)}
                    <span className="t1 font-medium"> {item.pct}%</span>
                  </span>
                </div>
                <Bar pct={item.pct} color={colorFor(item.cat)} height={4} />
              </div>
            ))}
          </div>

          <div className="mt-auto pt-2.5 hair-t space-y-1.5">
            <span className="flex items-center gap-3 text-[9.5px] t3 flex-wrap">
              {LEGEND.map((k) => (
                <span key={k.l} className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: k.c }} />
                  {k.l}
                </span>
              ))}
            </span>
            <span className="block text-[9.5px] t3">
              {formatHm(view.total)} tracked across the fleet
              {approximate ? ' · approximate' : ''}
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}
