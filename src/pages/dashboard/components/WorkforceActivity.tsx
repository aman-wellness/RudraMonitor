import { useMemo, useState } from 'react';
import { useOrgActivityHourly, useOrgProductivityDaily } from '@/lib/dataHooks';
import { useRefreshOnTick } from '../refreshBus';
import { useFilterWindow } from '../filterContext';
import { EmptyNote, MicroLabel, Panel } from './ui';
import { C, formatHm, niceCeil, smoothPath, useElementWidth } from './chartKit';

/* Activity over the selected range.

   The panel's own Today/7D/30D switcher is gone: it duplicated the page-level
   date filter and the two could disagree. Bucket size is now chosen from the
   range instead — hours for a single day, days for anything longer.

   No period-over-period comparison: the figure is the figure. */

export default function WorkforceActivity({ index = 0 }: { index?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const w = useFilterWindow();
  const intraday = w.days <= 1;

  // Only the relevant hook does real work; the other asks for the minimum.
  const { rows: hourly, loading: hourlyLoading, approximate, refresh: refreshHourly } =
    useOrgActivityHourly(intraday ? w.hours : 1, w.untilHours, w.agentId);
  const { rows: daily, loading: dailyLoading, refresh: refreshDaily } = useOrgProductivityDaily(
    intraday ? 1 : w.days,
    w.untilHours,
    w.agentId,
  );
  useRefreshOnTick(refreshHourly, refreshDaily);

  const series = useMemo(() => {
    if (intraday) {
      return hourly.map((r) => {
        const d = new Date(r.hour);
        const h = d.getHours();
        return {
          label: `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`,
          seconds: r.activeSeconds,
          agents: r.activeAgents,
        };
      });
    }
    return daily.map((r) => {
      const d = new Date(`${r.day_bucket}T00:00:00`);
      return {
        label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        seconds: r.active_seconds,
        agents: r.active_agents,
      };
    });
  }, [intraday, hourly, daily]);

  const summary = useMemo(() => {
    const totalSeconds = series.reduce((s, p) => s + p.seconds, 0);
    const peakAgents = Math.max(0, ...series.map((p) => p.agents));
    // Per agent per day, so the headline means the same thing at every range
    // length. Active days rather than window length keeps a young org from
    // being averaged over a month it didn't exist for.
    const activeDays = intraday
      ? 1
      : Math.max(1, series.filter((p) => p.seconds > 0).length);
    return {
      totalSeconds,
      peakAgents,
      avgSeconds: peakAgents > 0 ? totalSeconds / peakAgents / activeDays : 0,
    };
  }, [series, intraday]);


  const loading = intraday ? hourlyLoading : dailyLoading;
  const hasData = series.some((p) => p.seconds > 0);

  // ---- geometry ----
  const H = 132;
  const PAD = { l: 26, r: 6, t: 10, b: 16 };
  const innerW = Math.max(0, width - PAD.l - PAD.r);
  const innerH = H - PAD.t - PAD.b;
  const maxHours = niceCeil(Math.max(...series.map((p) => p.seconds / 3600), 0.5));
  const yFor = (seconds: number) =>
    PAD.t + innerH - (Math.min(seconds / 3600, maxHours) / maxHours) * innerH;
  const pts = series.map((p, i) => ({
    x: PAD.l + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW),
    y: yFor(p.seconds),
  }));
  // Clamped to the plot band so a sharp drop to zero can't bulge the curve
  // below the 0h gridline.
  const line = smoothPath(pts, { min: PAD.t, max: PAD.t + innerH });
  const area =
    pts.length > 1
      ? `${line} L ${pts[pts.length - 1].x} ${PAD.t + innerH} L ${pts[0].x} ${PAD.t + innerH} Z`
      : '';
  const meanSeconds = series.length > 0 ? summary.totalSeconds / series.length : 0;
  // The axis must end at the newest bucket, but "every Nth plus the last"
  // collides when the last sits next to an Nth — there, the last replaces it.
  const labelStep = Math.max(1, Math.ceil(series.length / 8));
  const labelIdx: number[] = [];
  for (let i = 0; i < series.length; i += labelStep) labelIdx.push(i);
  const lastIdx = series.length - 1;
  if (labelIdx.length > 0 && labelIdx[labelIdx.length - 1] !== lastIdx) {
    if (lastIdx - labelIdx[labelIdx.length - 1] < labelStep) labelIdx.pop();
    labelIdx.push(lastIdx);
  }
  const colW = innerW / Math.max(1, series.length);
  const active = hover !== null ? series[hover] : null;
  const bucket = intraday ? 'hour' : 'day';

  return (
    <Panel title="Workforce activity" hint={w.label} index={index}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <MicroLabel>Working hours / agent{intraday ? '' : ' per day'}</MicroLabel>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="num num-lg">{formatHm(summary.avgSeconds)}</span>
          </div>
        </div>

        {/* Hovered bucket reads out here rather than in a floating tooltip — no
            occlusion of the curve, and it can't clip at the panel edge. */}
        <div className="text-right min-h-[28px]">
          {active ? (
            <>
              <MicroLabel>{active.label}</MicroLabel>
              <p className="text-[11.5px] t1 font-medium mt-0.5">
                {formatHm(active.seconds)}
                <span className="t3 font-normal">
                  {' · '}
                  {active.agents} agent{active.agents === 1 ? '' : 's'}
                </span>
              </p>
            </>
          ) : (
            <>
              <MicroLabel>Fleet total</MicroLabel>
              <p className="text-[11.5px] t1 font-medium mt-0.5">
                {formatHm(summary.totalSeconds)}
                <span className="t3 font-normal"> · peak {summary.peakAgents}</span>
              </p>
            </>
          )}
        </div>
      </div>

      <div ref={ref} className="w-full mt-1.5" style={{ height: H }}>
        {loading && series.length === 0 ? (
          <EmptyNote title="Loading…" />
        ) : !hasData ? (
          <EmptyNote
            title="No activity recorded in this range"
            hint="Agents fill this in as soon as they start reporting."
          />
        ) : width > 0 ? (
          <svg width={width} height={H} onMouseLeave={() => setHover(null)}>
            <defs>
              <linearGradient id="wf-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.accent} stopOpacity="0.32" />
                <stop offset="100%" stopColor={C.accent} stopOpacity="0" />
              </linearGradient>
              <linearGradient id="wf-stroke" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={C.accent} />
                <stop offset="100%" stopColor={C.accent2} />
              </linearGradient>
            </defs>

            {[0, 0.5, 1].map((g) => {
              const y = PAD.t + innerH - g * innerH;
              return (
                <g key={g}>
                  <line x1={PAD.l} x2={width - PAD.r} y1={y} y2={y} stroke={C.line} strokeWidth="1" />
                  <text x={PAD.l - 6} y={y + 3} textAnchor="end" fill={C.t3} style={{ fontSize: 8.5 }}>
                    {Math.round(maxHours * g)}h
                  </text>
                </g>
              );
            })}

            {area && <path d={area} fill="url(#wf-fill)" className="fade-in" />}
            <path
              d={line}
              fill="none"
              stroke="url(#wf-stroke)"
              strokeWidth="2"
              strokeLinecap="round"
              pathLength={1}
              className="draw"
            />

            {/* Average reference — says at a glance whether the period is above
                or below its own norm. */}
            {meanSeconds > 0 && (
              <line
                x1={PAD.l}
                x2={width - PAD.r}
                y1={yFor(meanSeconds)}
                y2={yFor(meanSeconds)}
                stroke={C.neutral}
                strokeWidth="1"
                strokeDasharray="2 4"
                className="fade-in"
              />
            )}

            {hover !== null && pts[hover] && (
              <>
                <line
                  x1={pts[hover].x}
                  x2={pts[hover].x}
                  y1={PAD.t}
                  y2={PAD.t + innerH}
                  stroke={C.accent}
                  strokeWidth="1"
                  opacity="0.45"
                />
                <circle cx={pts[hover].x} cy={pts[hover].y} r="7" fill={C.accent} opacity="0.18" />
                <circle
                  cx={pts[hover].x}
                  cy={pts[hover].y}
                  r="3.5"
                  fill={C.accent}
                  stroke={C.panel}
                  strokeWidth="1.5"
                />
              </>
            )}

            {/* When the range runs up to now its newest bucket is still filling,
                so the dip into it is an artifact. Mark it hollow. */}
            {pts.length > 0 && hover === null && w.isLive && (
              <circle
                cx={pts[pts.length - 1].x}
                cy={pts[pts.length - 1].y}
                r="3"
                fill={C.panel}
                stroke={C.accent}
                strokeWidth="1.75"
                className="fade-in"
              />
            )}

            {series.map((_, i) => (
              <rect
                key={i}
                x={pts[i].x - colW / 2}
                y={PAD.t}
                width={colW}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}

            {series.map((p, i) =>
              labelIdx.includes(i) ? (
                <text
                  key={i}
                  x={pts[i].x}
                  y={H - 4}
                  textAnchor="middle"
                  fill={C.t3}
                  style={{ fontSize: 8.5 }}
                >
                  {p.label}
                </text>
              ) : null,
            )}
          </svg>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 mt-auto pt-2 hair-t text-[9.5px] t3">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span
              className="w-4 h-[2px] rounded-full"
              style={{ background: `linear-gradient(90deg, ${C.accent}, ${C.accent2})` }}
            />
            fleet hours / {bucket}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="w-4 h-[2px]"
              style={{
                background: `repeating-linear-gradient(90deg, ${C.neutral} 0 2px, transparent 2px 6px)`,
              }}
            />
            average
          </span>
        </span>
        <span>
          {hasData && w.isLive && `last ${bucket} in progress`}
          {approximate && intraday && ' · approximate'}
        </span>
      </div>
    </Panel>
  );
}
