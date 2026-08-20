import { useState } from 'react';
import { EmptyNote, MicroLabel, Panel } from '@/pages/dashboard/components/ui';
import { C, niceCeil, useElementBox } from '@/pages/dashboard/components/chartKit';
import { formatDurationShort } from '@/lib/labels';

/* Activity per hour: active and idle minutes, stacked.

   The previous version drew three grouped bars per hour — events, active, idle —
   sharing one y-axis despite events being a COUNT and the other two MINUTES, so
   the axis was meaningless and the bars incomparable. Stacking active + idle is
   the honest reading: together they are that hour's system-on time, so the bar
   height is "how long the machine was up" and the split is "how much of it was
   work". Event counts moved into the hover readout, where they don't distort
   the scale. */

type DataPoint = { time: string; events: number; active: number; idle: number };

/** Floor only — the plot takes whatever height the panel row gives it. */
const MIN_H = 150;
const PAD = { l: 28, r: 6, t: 10, b: 18 };

/** "per 30m" / "per hour" / "per 11h" — whatever one bar covers. */
const bucketLabel = (mins: number) => {
  if (mins < 60) return `per ${mins}m`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? 'per hour' : `per ${hrs}h`;
};

export default function TimelineChart({
  data,
  bucketMinutes,
  index = 0,
}: {
  data: DataPoint[];
  bucketMinutes: number;
  index?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width, height } = useElementBox<HTMLDivElement>();

  const H = Math.max(MIN_H, Math.round(height));
  const innerW = Math.max(0, width - PAD.l - PAD.r);
  const innerH = H - PAD.t - PAD.b;
  const max = niceCeil(Math.max(...data.map((d) => d.active + d.idle), 1));
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(22, slot * 0.62));
  const active = hover !== null ? data[hover] : null;

  const labelStep = Math.max(1, Math.ceil(data.length / 8));

  return (
    <Panel
      title="Activity timeline"
      index={index}
      hint={bucketLabel(bucketMinutes)}
      action={
        <span className="flex items-center gap-2.5 text-[9.5px] t3">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ background: C.success }} />
            active
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ background: C.warning }} />
            idle
          </span>
        </span>
      }
    >
      {/* Hovered hour reads out in the header rather than a floating tooltip —
          the old absolutely-positioned one clipped at the panel edge.

          Deliberately no window total here: per-hour `idle` counts explicit idle
          rows, while the Idle figure in the strip above is effective idle
          (explicit rows OR unfocused wall gaps, whichever is larger). Showing
          both totals side by side made the page look like it was contradicting
          itself. */}
      {/* Fixed reserve so hovering doesn't shift the plot, but aligned to the
          TOP of that reserve — bottom-aligning it left a 30px band of dead air
          hanging under the panel header. */}
      <div className="flex items-start justify-between gap-3 min-h-[30px] flex-shrink-0">
        {active ? (
          <>
            <div>
              <MicroLabel>{active.time}</MicroLabel>
              <p className="text-[12px] t1 font-medium mt-1 tnum">
                {formatDurationShort(active.active * 60)} active
                <span className="t3 font-normal"> · {formatDurationShort(active.idle * 60)} idle</span>
              </p>
            </div>
            {active.events > 0 && (
              <p className="text-[10px] t3">
                {active.events} event{active.events === 1 ? '' : 's'}
              </p>
            )}
          </>
        ) : (
          <p className="text-[10px] t3">Hover a bar for its active / idle split.</p>
        )}
      </div>

      {/* flex-1 + absolutely-positioned svg: the plot expands to use the height
          this panel gets from its taller neighbour instead of leaving a gap. */}
      <div ref={ref} className="w-full flex-1 relative" style={{ minHeight: MIN_H }}>
        {data.length === 0 ? (
          <EmptyNote
            title="No activity recorded in this window"
            hint="Pick a wider date range, or check the agent is reporting."
          />
        ) : width > 0 ? (
          <svg
            width={width}
            height={H}
            className="absolute inset-0"
            onMouseLeave={() => setHover(null)}
          >
            {[0, 0.5, 1].map((g) => {
              const y = PAD.t + innerH - g * innerH;
              return (
                <g key={g}>
                  <line x1={PAD.l} x2={width - PAD.r} y1={y} y2={y} stroke={C.line} strokeWidth="1" />
                  <text x={PAD.l - 6} y={y + 3} textAnchor="end" fill={C.t3} style={{ fontSize: 8.5 }}>
                    {/* Wide windows push the axis into the hundreds of minutes,
                        where "800m" is worse than "13h 20m". */}
                    {g === 0 ? '0' : formatDurationShort(Math.round(max * g) * 60)}
                  </text>
                </g>
              );
            })}

            {data.map((d, i) => {
              const x = PAD.l + i * slot + (slot - barW) / 2;
              const activeH = (d.active / max) * innerH;
              const idleH = (d.idle / max) * innerH;
              const dim = hover !== null && hover !== i;
              return (
                <g key={i} opacity={dim ? 0.4 : 1} style={{ transition: 'opacity 0.14s ease' }}>
                  {/* idle sits on top of active, so the column height is the
                      hour's total system-on time */}
                  <rect
                    x={x}
                    y={PAD.t + innerH - activeH}
                    width={barW}
                    height={Math.max(0, activeH)}
                    fill={C.success}
                    rx="2"
                  />
                  <rect
                    x={x}
                    y={PAD.t + innerH - activeH - idleH}
                    width={barW}
                    height={Math.max(0, idleH)}
                    fill={C.warning}
                    rx="2"
                  />
                  <rect
                    x={PAD.l + i * slot}
                    y={PAD.t}
                    width={slot}
                    height={innerH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                  />
                </g>
              );
            })}

            {data.map((d, i) =>
              i % labelStep === 0 || i === data.length - 1 ? (
                <text
                  key={i}
                  x={PAD.l + i * slot + slot / 2}
                  y={H - 4}
                  textAnchor="middle"
                  fill={C.t3}
                  style={{ fontSize: 8.5 }}
                >
                  {d.time}
                </text>
              ) : null,
            )}
          </svg>
        ) : null}
      </div>
    </Panel>
  );
}
