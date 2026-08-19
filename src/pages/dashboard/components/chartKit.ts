import { useEffect, useRef, useState } from 'react';

/* ============================================================================
   Dashboard chart/format kit — the non-component half of the design system.
   The visual tokens themselves live in index.css under `.dash`.

   Colours are CSS custom properties, not hex. SVG resolves `var(--d-accent)`
   in stroke/fill/stop-color, so one definition covers light and dark instead
   of two palettes kept in sync by hand. Where a ramp is needed (heatmaps,
   presence strips) the element gets a solid accent background plus an
   `opacity` — which composites correctly over a white *or* a near-black
   surface, unlike a baked rgba().
   ========================================================================== */

export const C = {
  accent: 'var(--d-accent)',
  accent2: 'var(--d-accent-2)',
  success: 'var(--d-success)',
  warning: 'var(--d-warning)',
  danger: 'var(--d-danger)',
  sevHigh: 'var(--d-sev-high)',
  info: 'var(--d-info)',
  neutral: 'var(--d-neutral)',
  line: 'var(--d-line)',
  track: 'var(--d-track)',
  panel: 'var(--d-panel)',
  t3: 'var(--d-t3)',
} as const;

export const formatHm = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const niceCeil = (v: number) => {
  if (v <= 1) return 1;
  const steps = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 800, 1000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 1000) * 1000;
};

/** Pixel width of a container, for SVG charts that must not distort. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/**
 * Width AND height of a container, for charts that should fill whatever space
 * their panel has rather than sit at a fixed height with dead air beneath.
 *
 * The measured element must get its own height from layout (flex-1) and the SVG
 * must be absolutely positioned inside it — if the SVG contributed to the
 * element's height, setting that height from the measurement would feed back
 * into the observer.
 */
export function useElementBox<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Ignore sub-pixel churn; fractional layout widths would otherwise re-render
    // on every scrollbar/zoom nudge.
    const read = (width: number, height: number) =>
      setBox((prev) =>
        Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
          ? prev
          : { width, height },
      );
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) read(r.width, r.height);
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    read(r.width, r.height);
    return () => ro.disconnect();
  }, []);
  return { ref, width: box.width, height: box.height };
}

/**
 * Catmull-Rom → cubic bezier, so the curve passes through every sample instead
 * of cutting the corner on spiky fleet data.
 *
 * `bounds` clamps the CONTROL points to the plot band. A cubic bezier is
 * contained by the convex hull of its four control points, so clamping the two
 * middle ones guarantees the drawn curve can never leave the band — which is
 * what stops a sharp drop to zero from bulging below the 0 gridline into
 * visually negative territory.
 */
export const smoothPath = (
  pts: { x: number; y: number }[],
  bounds?: { min: number; max: number },
) => {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  const clamp = (y: number) =>
    bounds ? Math.min(bounds.max, Math.max(bounds.min, y)) : y;
  let d = `M ${pts[0].x} ${clamp(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clamp(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clamp(p2.y - (p3.y - p1.y) / 6);
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${clamp(p2.y).toFixed(1)}`;
  }
  return d;
};

/** Ramp position → opacity, sqrt-shaped so quiet buckets stay visible instead
 *  of being crushed into the background by one busy peak. */
export const rampOpacity = (value: number, max: number) =>
  max <= 0 || value <= 0 ? 0 : 0.16 + Math.sqrt(value / max) * 0.84;
