import type { ReactNode } from 'react';
import { C } from './chartKit';

/* Dashboard panel + metric components. All visual tokens (surfaces, hairlines,
   type scale, motion) come from the `.dash` block in index.css; formatting and
   chart maths live in ./chartKit. This file exports components only, so
   react-refresh stays happy. */

/* ---------------------------------------------------------------- Panel --- */

export function Panel({
  title,
  hint,
  action,
  children,
  className = '',
  flush = false,
  index = 0,
}: {
  title: string;
  /** Small right-aligned context in the header (e.g. "Last 24h"). */
  hint?: ReactNode;
  /** Interactive header control — range switcher, link. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Drop the body padding (tables, full-bleed lists). */
  flush?: boolean;
  /** Position down the page — staggers the entrance animation. */
  index?: number;
}) {
  return (
    /* flex-1 so a panel fills the flex wrapper the page grid puts it in —
       that's what makes side-by-side panels share one height. */
    <section
      className={`panel rise flex flex-col flex-1 ${className}`}
      style={{ ['--i' as string]: index }}
    >
      <header className="panel-head flex-shrink-0">
        <h3 className="panel-title truncate">{title}</h3>
        <div className="flex items-center gap-2 flex-shrink-0">
          {hint && <span className="label">{hint}</span>}
          {action}
        </div>
      </header>
      <div className={`${flush ? '' : 'panel-body'} flex-1 min-w-0 flex flex-col`}>{children}</div>
    </section>
  );
}

/** Section band — a label plus a fading rule. Groups the page into readable
 *  bands so it doesn't present as one undifferentiated wall of panels. */
export function SectionBand({ label, aside }: { label: string; aside?: ReactNode }) {
  return (
    <div className="sec">
      <span className="sec-label">{label}</span>
      <span className="sec-rule" />
      {aside}
    </div>
  );
}

export function MicroLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`label ${className}`}>{children}</span>;
}

/** Segmented range switcher — the only "tab" pattern on the page.
 *  NoInfer on everything but `value`: without it TS infers T from the
 *  setState-shaped onChange and widens to the `string` constraint. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: NoInfer<T>; label: string }[];
  onChange: (id: NoInfer<T>) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`seg-btn ${value === o.id ? 'is-on' : ''}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Sparkline --- */

export function Sparkline({
  points,
  color = C.accent,
  w = 44,
  h = 16,
  fill = false,
}: {
  points: number[];
  color?: string;
  w?: number;
  h?: number;
  fill?: boolean;
}) {
  if (points.length < 2) return <span style={{ width: w, height: h }} className="inline-block" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / span) * (h - 3) - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="flex-shrink-0">
      {fill && (
        <polygon
          points={`0,${h} ${coords.join(' ')} ${w},${h}`}
          fill={color}
          opacity="0.13"
          className="fade-in"
        />
      )}
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        className="draw"
      />
    </svg>
  );
}

/** Thin proportion bar. Grows from zero on mount. */
export function Bar({
  pct,
  color = C.accent,
  height = 4,
  animate = true,
}: {
  pct: number;
  color?: string;
  height?: number;
  animate?: boolean;
}) {
  return (
    <span className="track block" style={{ height }}>
      <i
        className={animate ? 'grow' : undefined}
        style={{ width: `${Math.max(1.5, Math.min(100, pct))}%`, background: color }}
      />
    </span>
  );
}

/* ----------------------------------------------------------- Empty state -- */

export function EmptyNote({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex-1 min-h-[88px] flex flex-col items-center justify-center text-center gap-1 py-5">
      <span className="w-7 h-7 rounded-lg sunken flex items-center justify-center mb-0.5">
        <i className="ri-bar-chart-2-line text-[12px] t3" />
      </span>
      <p className="text-[11px] t2">{title}</p>
      {hint && <p className="text-[10px] t3 max-w-[30ch] leading-relaxed">{hint}</p>}
    </div>
  );
}
