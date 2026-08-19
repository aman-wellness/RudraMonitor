import { useMemo, useState } from 'react';
import { useOrgActivityHourly, useOrgWorkHours } from '@/lib/dataHooks';
import { useRefreshOnTick } from '../refreshBus';
import { useFilterWindow } from '../filterContext';
import { EmptyNote, MicroLabel, Panel } from './ui';
import { C, formatHm, rampOpacity } from './chartKit';

/* Day × hour heatmap over the last 7 days.

   Answers what a table can't: when the team starts, when it stops, who works
   weekends, and how much happens outside working hours.

   "Outside hours" is read from the org's OWN tracking schedule (migration
   0115) — the same schedule the desktop agents use to decide when to capture —
   so an org working 07:00–15:00, or six days a week, isn't measured against
   somebody else's 9-to-6. Only when no schedule is configured does it fall
   back to Mon–Fri 09:00–18:00, and the footnote says so.

   Off-hours cells are flagged by hue rather than a background band: the
   shaded hours now differ per day, so a single band would no longer line up. */

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function WorkPatternHeatmap({ index = 0 }: { index?: number }) {
  const [hover, setHover] = useState<{ day: number; hour: number } | null>(null);
  const w = useFilterWindow();
  // Always seven day-rows: the grid IS a weekly shape. It ends on the
  // selected range's last day so a historical range still lines up.
  const { rows, loading, refresh } = useOrgActivityHourly(24 * 7, w.untilHours, w.agentId);
  const work = useOrgWorkHours();
  useRefreshOnTick(refresh);

  // Weekday of each row, so schedule lookups match the calendar.
  const dowOf = (dayIndex: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (6 - dayIndex));
    return d.getDay();
  };

  const model = useMemo(() => {
    // grid[dayIndex][hour], dayIndex 0 = six days ago, 6 = today.
    const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let total = 0;
    let afterHours = 0;
    let offDays = 0;
    const hourTotals = Array.from({ length: 24 }, () => 0);

    for (const r of rows) {
      const d = new Date(r.hour);
      const dayStart = new Date(d);
      dayStart.setHours(0, 0, 0, 0);
      const dayIndex = 6 - Math.round((today.getTime() - dayStart.getTime()) / 86400000);
      if (dayIndex < 0 || dayIndex > 6) continue;
      const hour = d.getHours();
      grid[dayIndex][hour] += r.activeSeconds;
      total += r.activeSeconds;
      hourTotals[hour] += r.activeSeconds;

      const scheduled = work.byDay[dayStart.getDay()];
      if (!scheduled?.has(hour)) afterHours += r.activeSeconds;
      // A day with no scheduled hours at all is a non-working day for this org.
      if (!scheduled || scheduled.size === 0) offDays += r.activeSeconds;
    }

    const peak = Math.max(...hourTotals);
    return {
      grid,
      max: Math.max(0, ...grid.flat()),
      total,
      afterHoursPct: total > 0 ? Math.round((afterHours / total) * 100) : 0,
      offDaysPct: total > 0 ? Math.round((offDays / total) * 100) : 0,
      busiestHour: peak > 0 ? hourTotals.indexOf(peak) : null,
    };
  }, [rows, work.byDay]);

  // Label from the calendar, not from whether the day had data, so a quiet day
  // keeps its own name instead of shifting the rows.
  const dayDate = (dayIndex: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (6 - dayIndex));
    return d;
  };
  const label = (dayIndex: number) => DAY_LABELS[dayDate(dayIndex).getDay()];
  const fullLabel = (dayIndex: number) =>
    dayDate(dayIndex).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });

  const hovered = hover !== null ? model.grid[hover.day]?.[hover.hour] ?? 0 : null;
  const hour12 = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'AM' : 'PM'}`;
  const isWorkHour = (dayIndex: number, hour: number) => !!work.byDay[dowOf(dayIndex)]?.has(hour);

  return (
    <Panel
      title="Work patterns"
      hint="Last 7 days"
      index={index}
      action={
        <span className="flex items-center gap-1.5 text-[9.5px] t3">
          less
          {[0.2, 0.45, 0.7, 1].map((t) => (
            <span
              key={t}
              className="w-2 h-2 rounded-[2.5px]"
              style={{ background: C.accent, opacity: t }}
            />
          ))}
          more
        </span>
      }
    >
      {loading && rows.length === 0 ? (
        <EmptyNote title="Loading…" />
      ) : model.total === 0 ? (
        <EmptyNote
          title="No activity in the last 7 days"
          hint="This grid shows which hours your team is actually working."
        />
      ) : (
        <>
          <div className="overflow-x-auto -mx-1 px-1 flex-1 min-h-0 flex flex-col">
            <div className="min-w-[470px] flex-1 flex flex-col">
              {/* hour ruler */}
              <div className="flex items-center gap-[2px] pl-[29px] mb-0.5">
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} className="flex-1 text-center text-[8px] t3 tnum">
                    {h % 3 === 0 ? h : ''}
                  </span>
                ))}
              </div>

              <div className="heat-rows">
                {model.grid.map((row, dayIndex) => (
                <div key={dayIndex} className="heat-row">
                  <span
                    className="w-[27px] text-[8.5px] t3 uppercase tracking-wide flex-shrink-0 self-center"
                    title={fullLabel(dayIndex)}
                  >
                    {label(dayIndex)}
                  </span>
                  {row.map((seconds, hour) => {
                    const outside = !isWorkHour(dayIndex, hour);
                    return (
                      <button
                        key={hour}
                        type="button"
                        onMouseEnter={() => setHover({ day: dayIndex, hour })}
                        onMouseLeave={() => setHover(null)}
                        title={`${fullLabel(dayIndex)}, ${hour}:00 — ${formatHm(seconds)}${
                          outside ? ' (outside working hours)' : ''
                        }`}
                        className="heat-cell flex-1"
                      >
                        <i
                          style={{
                            opacity: rampOpacity(seconds, model.max),
                            // Hue, not an outline: a busy cell in the wrong
                            // place should be obvious at a glance.
                            background: outside && seconds > 0 ? C.warning : undefined,
                          }}
                        />
                      </button>
                    );
                  })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* mt-auto here rather than on the footnote: when this panel is
              shorter than its row neighbour, the slack should fall in one place
              below the grid, keeping the stats and their footnote together. */}
          <div className="grid grid-cols-3 gap-3 mt-3 pt-2.5 hair-t">
            <div>
              <MicroLabel>Peak hour</MicroLabel>
              <p className="text-[12px] t1 font-medium mt-1 tnum">
                {model.busiestHour === null ? '—' : hour12(model.busiestHour)}
              </p>
            </div>
            <div>
              <MicroLabel>Outside hours</MicroLabel>
              <p
                className={`text-[12px] font-medium mt-1 tnum ${
                  model.afterHoursPct >= 25 ? 't-warning' : 't1'
                }`}
                title="Share of tracked time outside the org's configured working hours"
              >
                {model.afterHoursPct}%
              </p>
            </div>
            <div>
              <MicroLabel>Non-working days</MicroLabel>
              <p
                className={`text-[12px] font-medium mt-1 tnum ${
                  model.offDaysPct >= 10 ? 't-warning' : 't1'
                }`}
                title="Share of tracked time on days with no scheduled working hours"
              >
                {model.offDaysPct}%
              </p>
            </div>
          </div>

          <p className="text-[9.5px] t3 pt-2">
            {hovered !== null && hover ? (
              `${fullLabel(hover.day)} at ${hour12(hover.hour)} · ${formatHm(hovered)} of fleet activity`
            ) : work.configured ? (
              'Amber cells fall outside your configured working hours.'
            ) : (
              <>
                Amber cells fall outside Mon–Fri 9am–6pm (no schedule set).{' '}
                <a href="/org-settings" className="t-accent hover:underline">
                  Configure
                </a>
              </>
            )}
          </p>
        </>
      )}
    </Panel>
  );
}
