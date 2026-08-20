import { useMemo } from 'react';
import { useProductivityRules } from '@/lib/dataHooks';
import { Bar, EmptyNote, Panel } from '@/pages/dashboard/components/ui';
import { C } from '@/pages/dashboard/components/chartKit';

/* Where this agent's foreground time went.

   Bars are coloured by the org's own productivity rules, not by an arbitrary
   per-row palette. The old version assigned teal/orange/blue/purple in list
   order, so the colours carried no meaning while looking like they did —
   "Slack orange, Terminal blue" said nothing. Now green/amber/grey means
   productive/unproductive/uncategorised, matching the dashboard. */

type AppTime = { name: string; percent: number; time: string };

const LEGEND = [
  { c: C.success, l: 'productive' },
  { c: C.warning, l: 'unproductive' },
  { c: C.neutral, l: 'uncategorised' },
];

export default function TimePerApp({ apps, index = 0 }: { apps: AppTime[]; index?: number }) {
  const { rules } = useProductivityRules();

  const category = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rules) {
      if (r.match_type === 'app') map.set(r.pattern.toLowerCase(), r.category);
    }
    return map;
  }, [rules]);

  const colorFor = (name: string) => {
    const cat = category.get(name.toLowerCase());
    return cat === 'productive' ? C.success : cat === 'unproductive' ? C.warning : C.neutral;
  };

  return (
    <Panel title="Time per application" index={index}>
      {apps.length === 0 ? (
        <EmptyNote title="No application activity in this window" />
      ) : (
        <>
          {/* Two columns from md up. As one full-width list each row stretched
              the whole panel, leaving the duration stranded ~900px from the app
              name it belongs to — the pairing was unreadable at a glance. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2.5">
            {apps.map((app) => (
              <div key={app.name} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <span className="text-[11.5px] t2 truncate" title={app.name}>
                    {app.name}
                  </span>
                  <span className="text-[11.5px] t3 tnum flex-shrink-0">
                    {app.time}
                    <span className="t1 font-medium"> {app.percent}%</span>
                  </span>
                </div>
                <Bar pct={app.percent} color={colorFor(app.name)} height={5} />
              </div>
            ))}
          </div>

          <span className="flex items-center gap-3 text-[9.5px] t3 flex-wrap mt-auto pt-3 hair-t">
            {LEGEND.map((k) => (
              <span key={k.l} className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: k.c }} />
                {k.l}
              </span>
            ))}
          </span>
        </>
      )}
    </Panel>
  );
}
