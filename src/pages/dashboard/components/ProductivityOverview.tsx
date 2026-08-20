import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAgents, useProductivityPerAgent } from '@/lib/dataHooks';
import { useRefreshOnTick } from '../refreshBus';
import { useFilterWindow } from '../filterContext';
import { EmptyNote, MicroLabel, Panel } from './ui';
import { C, formatHm } from './chartKit';

/* Tracked foreground time, split three ways:
     productive   — matched a productivity_rule with category 'productive'
     unproductive — matched a rule with category 'unproductive'
     neutral      — matched no rule at all (nothing is assumed about it)

   The ring is the chart, so it gets the space. The previous version put three
   progress bars beside it showing the same three numbers — the duplicate
   encoding halved the ring's size for no extra information. Now the ring is
   large with separated segments, each segment highlights on hover, and the
   legend carries the numbers the ring can't: absolute time per bucket. */

const SLICES = [
  { key: 'productive', label: 'Productive', color: C.success },
  { key: 'neutral', label: 'Uncategorised', color: C.neutral },
  { key: 'unproductive', label: 'Unproductive', color: C.warning },
] as const;

const SIZE = 116;
const R = 46;
const STROKE = 13;
const CIRC = 2 * Math.PI * R;
// Visual separation between adjacent arcs, in px of circumference.
const GAP = 3;

export default function ProductivityOverview({ index = 0 }: { index?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const w = useFilterWindow();
  const { byAgent, loading, refresh: refreshSplit } = useProductivityPerAgent(
    w.sinceHours, w.untilHours,
  );
  const { agents: allAgents, refresh: refreshAgents } = useAgents();
  const agents = useMemo(
    () => (w.agentId ? allAgents.filter((a) => a.id === w.agentId) : allAgents),
    [allAgents, w.agentId],
  );
  useRefreshOnTick(refreshSplit, refreshAgents);

  const split = useMemo(() => {
    let active = 0;
    let productive = 0;
    let unproductive = 0;
    let idle = 0;
    for (const agg of Object.values(byAgent)) {
      if (w.agentId && agg.agent_id !== w.agentId) continue;
      active += agg.active_seconds;
      productive += agg.weighted_seconds;
      unproductive += agg.unproductive_seconds;
      idle += agg.idle_seconds;
    }
    const neutral = Math.max(0, active - productive - unproductive);
    const pct = (v: number) => (active > 0 ? Math.round((v / active) * 100) : 0);
    return {
      active,
      idle,
      seconds: { productive, neutral, unproductive },
      pcts: { productive: pct(productive), neutral: pct(neutral), unproductive: pct(unproductive) },
      scorePct:
        productive + unproductive > 0
          ? Math.round((productive / (productive + unproductive)) * 100)
          : null,
    };
  }, [byAgent, w.agentId]);


  // Who to praise and who to look at — the two names an owner wants from this.
  const ranked = useMemo(() => {
    const rows = agents
      .map((a) => {
        const agg = byAgent[a.id];
        if (!agg) return null;
        const matched = agg.weighted_seconds + agg.unproductive_seconds;
        if (matched === 0) return null;
        return { id: a.id, name: a.name, pct: Math.round((agg.weighted_seconds / matched) * 100) };
      })
      .filter((r): r is { id: string; name: string; pct: number } => r !== null)
      .sort((a, b) => b.pct - a.pct);
    return { best: rows[0] ?? null, worst: rows.length > 1 ? rows[rows.length - 1] : null };
  }, [agents, byAgent]);

  // Lay the arcs head-to-tail, each shortened by GAP so the joins read as
  // separate segments instead of one continuous band.
  let offset = 0;
  const arcs = SLICES.map((s) => {
    const fraction = split.active > 0 ? split.seconds[s.key] / split.active : 0;
    const len = Math.max(0, fraction * CIRC - (fraction > 0 ? GAP : 0));
    const arc = { ...s, fraction, len, offset };
    offset += fraction * CIRC;
    return arc;
  });

  const empty = split.active === 0;
  const idlePct =
    split.active + split.idle > 0 ? Math.round((split.idle / (split.active + split.idle)) * 100) : 0;
  const centre = SIZE / 2;
  const active = hover ? SLICES.find((s) => s.key === hover) : null;

  return (
    <Panel title="How the time was spent" hint={w.label} index={index}>
      {loading && empty ? (
        <EmptyNote title="Loading…" />
      ) : empty ? (
        <EmptyNote
          title="No tracked activity in this range"
          hint="The ring fills in once agents report app and browser time."
        />
      ) : (
        <>
          <div className="flex items-center justify-center gap-4 pt-0.5">
            <div className="relative flex-shrink-0" style={{ width: SIZE, height: SIZE }}>
              <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="fade-in">
                <circle cx={centre} cy={centre} r={R} fill="none" stroke={C.track} strokeWidth={STROKE} />
                {arcs.map((a) =>
                  a.fraction > 0 ? (
                    <circle
                      key={a.key}
                      cx={centre}
                      cy={centre}
                      r={R}
                      fill="none"
                      stroke={a.color}
                      strokeWidth={hover === a.key ? STROKE + 3 : STROKE}
                      strokeDasharray={`${a.len.toFixed(2)} ${(CIRC - a.len).toFixed(2)}`}
                      strokeDashoffset={(-a.offset).toFixed(2)}
                      transform={`rotate(-90 ${centre} ${centre})`}
                      strokeLinecap="butt"
                      opacity={hover && hover !== a.key ? 0.35 : 1}
                      style={{ transition: 'stroke-width 0.16s ease, opacity 0.16s ease' }}
                      onMouseEnter={() => setHover(a.key)}
                      onMouseLeave={() => setHover(null)}
                    />
                  ) : null,
                )}
              </svg>

              {/* Centre reads out the hovered segment, else the overall score. */}
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                {active ? (
                  <>
                    <span className="num" style={{ fontSize: 22, color: active.color }}>
                      {split.pcts[active.key]}%
                    </span>
                    <span className="text-[9px] t3 mt-1">{formatHm(split.seconds[active.key])}</span>
                  </>
                ) : (
                  <>
                    <span className="num" style={{ fontSize: 26 }}>
                      {split.scorePct === null ? '—' : `${split.scorePct}%`}
                    </span>
                    <span className="text-[8px] t3 uppercase tracking-[0.14em] mt-1">score</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex-1 min-w-0 space-y-2.5">
              {SLICES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onMouseEnter={() => setHover(s.key)}
                  onMouseLeave={() => setHover(null)}
                  className="flex items-baseline gap-2 w-full min-w-0 text-left"
                  style={{ opacity: hover && hover !== s.key ? 0.45 : 1, transition: 'opacity 0.16s ease' }}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
                    style={{ background: s.color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11px] t2 truncate leading-tight">{s.label}</span>
                    <span className="block text-[9.5px] t3 tnum mt-0.5">
                      {formatHm(split.seconds[s.key])}
                    </span>
                  </span>
                  <span className="num tnum flex-shrink-0" style={{ fontSize: 13 }}>
                    {split.pcts[s.key]}%
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-3 pt-2.5 hair-t">
            <div className="min-w-0">
              <MicroLabel>Tracked</MicroLabel>
              <p className="text-[11.5px] t1 font-medium mt-1 tnum">{formatHm(split.active)}</p>
            </div>
            <div className="min-w-0">
              <MicroLabel>Idle share</MicroLabel>
              <p className="text-[11.5px] t1 font-medium mt-1 tnum">{idlePct}%</p>
            </div>
            {ranked.best && (
              <div className="min-w-0">
                <MicroLabel>Top performer</MicroLabel>
                <Link
                  to={`/agents/${ranked.best.id}`}
                  className="text-[11px] t-success hover:underline block truncate mt-1"
                >
                  {ranked.best.name} · {ranked.best.pct}%
                </Link>
              </div>
            )}
            {ranked.worst && (
              <div className="min-w-0">
                <MicroLabel>Needs a look</MicroLabel>
                <Link
                  to={`/agents/${ranked.worst.id}`}
                  className="text-[11px] t-warning hover:underline block truncate mt-1"
                >
                  {ranked.worst.name} · {ranked.worst.pct}%
                </Link>
              </div>
            )}
          </div>

          {/* Only surfaces when most time is unmatched, i.e. when the split
              above can't say much until rules exist. */}
          {split.pcts.neutral > 50 && (
            <div className="mt-auto pt-2.5 flex items-center justify-between gap-2">
              <span className="text-[9.5px] t3">Most time is uncategorised</span>
              <Link to="/admin-portal" className="chip chip-quiet text-[9.5px]">
                Add rules
                <i className="ri-arrow-right-line" />
              </Link>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
