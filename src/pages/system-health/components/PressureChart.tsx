import { useState } from 'react';
import { EmptyNote, Panel } from '@/pages/dashboard/components/ui';
import { C, useElementBox } from '@/pages/dashboard/components/chartKit';
import type { Bucket } from '../useFleetMetrics';

/* Fleet CPU / memory / disk over the selected window.
 *
 * The agent-detail health card has always said "historical charts live on the
 * System Health page" — this is the first time that's been true. The data was
 * already there: system_metrics holds a month of samples.
 *
 * Buckets with no samples are null, and the line breaks at them rather than
 * interpolating across a reporting outage. */

const PAD = { l: 30, r: 8, t: 10, b: 18 };
const MIN_H = 170;

type Series = { key: 'cpu' | 'memory' | 'disk'; label: string; color: string };

const SERIES: Series[] = [
  { key: 'cpu', label: 'CPU', color: C.accent },
  { key: 'memory', label: 'Memory', color: C.accent2 },
  { key: 'disk', label: 'Disk I/O', color: C.warning },
];

export default function PressureChart({
  series,
  windowLabel,
  spanHours,
  index = 0,
}: {
  series: Bucket[];
  windowLabel: string;
  /** Decides whether axis labels need a date — a clock time repeats across days. */
  spanHours: number;
  index?: number;
}) {
  const { ref, width, height } = useElementBox<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<Series['key']>>(new Set());

  const H = Math.max(MIN_H, Math.round(height));
  const innerW = Math.max(0, width - PAD.l - PAD.r);
  const innerH = H - PAD.t - PAD.b;
  const withData = series.filter((b) => b.samples > 0);
  const active = hover !== null ? series[hover] : null;

  const x = (i: number) => PAD.l + (series.length <= 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v: number) => PAD.t + innerH - (v / 100) * innerH;

  // One <path> per contiguous run of samples, so gaps stay gaps.
  const runs = (key: Series['key']) => {
    const out: string[] = [];
    let d = '';
    series.forEach((b, i) => {
      const v = b[key];
      if (v === null) { if (d) { out.push(d); d = ''; } return; }
      d += `${d ? ' L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    });
    if (d) out.push(d);
    return out;
  };

  const stamp = (t: number) =>
    new Date(t).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });

  return (
    <Panel
      title="Fleet pressure"
      index={index}
      hint={windowLabel}
      action={
        <span className="flex items-center gap-2.5">
          {SERIES.map((s) => {
            const off = hidden.has(s.key);
            return (
              <button
                key={s.key}
                onClick={() => setHidden((p) => {
                  const n = new Set(p);
                  if (n.has(s.key)) n.delete(s.key); else n.add(s.key);
                  return n;
                })}
                className="flex items-center gap-1.5 text-[9.5px] t3"
                style={{ opacity: off ? 0.4 : 1 }}
                title={off ? `Show ${s.label}` : `Hide ${s.label}`}
              >
                <span className="w-2 h-2 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </button>
            );
          })}
        </span>
      }
    >
      <div className="flex items-start justify-between gap-3 min-h-[30px] flex-shrink-0">
        {active && active.samples > 0 ? (
          <>
            <div>
              <span className="label">{stamp(active.t)}</span>
              <p className="text-[12px] t1 font-medium mt-1 tnum">
                {SERIES.filter((s) => !hidden.has(s.key)).map((s, i) => (
                  <span key={s.key}>
                    {i > 0 && <span className="t3 font-normal"> · </span>}
                    <span style={{ color: s.color }}>{active[s.key]}%</span>
                    <span className="t3 font-normal"> {s.label.toLowerCase()}</span>
                  </span>
                ))}
              </p>
            </div>
            <p className="text-[10px] t3 whitespace-nowrap">
              {active.samples} sample{active.samples === 1 ? '' : 's'}
            </p>
          </>
        ) : (
          <p className="text-[10px] t3">
            {withData.length === 0
              ? 'No samples in this window.'
              : 'Fleet average across reporting agents. Hover for a point.'}
          </p>
        )}
      </div>

      <div ref={ref} className="w-full flex-1 relative" style={{ minHeight: MIN_H }}>
        {withData.length === 0 ? (
          <EmptyNote
            title="No hardware samples in this window"
            hint="Agents report CPU, memory and disk every minute while they're running."
          />
        ) : width > 0 ? (
          <svg
            width={width}
            height={H}
            className="absolute inset-0"
            onMouseLeave={() => setHover(null)}
          >
            {[0, 25, 50, 75, 100].map((g) => (
              <g key={g}>
                <line
                  x1={PAD.l}
                  x2={width - PAD.r}
                  y1={y(g)}
                  y2={y(g)}
                  stroke={C.line}
                  strokeWidth="1"
                />
                <text x={PAD.l - 6} y={y(g) + 3} textAnchor="end" fill={C.t3} style={{ fontSize: 8.5 }}>
                  {g}
                </text>
              </g>
            ))}

            {SERIES.filter((s) => !hidden.has(s.key)).map((s) =>
              runs(s.key).map((d, i) => (
                <path
                  key={`${s.key}-${i}`}
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )),
            )}

            {active && active.samples > 0 && (
              <line
                x1={x(hover!)}
                x2={x(hover!)}
                y1={PAD.t}
                y2={PAD.t + innerH}
                stroke={C.line}
                strokeWidth="1"
              />
            )}
            {active && active.samples > 0 &&
              SERIES.filter((s) => !hidden.has(s.key) && active[s.key] !== null).map((s) => (
                <circle
                  key={s.key}
                  cx={x(hover!)}
                  cy={y(active[s.key]!)}
                  r="2.5"
                  fill={s.color}
                />
              ))}

            {series.map((_, i) => (
              <rect
                key={i}
                x={PAD.l + (i - 0.5) * (innerW / Math.max(1, series.length - 1))}
                y={PAD.t}
                width={innerW / Math.max(1, series.length - 1)}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}

            {/* First, middle and last bucket times — enough to read the span. */}
            {[0, Math.floor(series.length / 2), series.length - 1].map((i) => (
              <text
                key={i}
                x={x(i)}
                y={H - 4}
                textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}
                fill={C.t3}
                style={{ fontSize: 8.5 }}
              >
                {spanHours > 24
                  ? new Date(series[i].t).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
                  : new Date(series[i].t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </text>
            ))}
          </svg>
        ) : null}
      </div>
    </Panel>
  );
}
