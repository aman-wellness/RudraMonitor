import { createContext, useContext } from 'react';

/* ============================================================================
   Dashboard filter — one source of truth for "which agent" and "which dates",
   consumed by every panel.

   The panels' data hooks all speak in RELATIVE hours (sinceHours / untilHours)
   because that's what the aggregation RPCs take. The picker works in absolute
   dates. `useFilterWindow()` converts between the two once, here, so no panel
   has to redo that arithmetic — and so they can't drift apart.

   `to` is stored as the END of its day (23:59:59.999), so picking the same date
   for both ends means "that whole day", which is what a person selecting a
   single date expects.
   ========================================================================== */

export type PresetId =
  | 'today'
  | 'yesterday'
  | '7d'
  | '14d'
  | '30d'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom';

export type DashFilter = {
  preset: PresetId;
  from: Date;
  to: Date;
  /** null = whole organisation. */
  agentId: string | null;
};

export const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export const endOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

export const PRESETS: { id: PresetId; label: string; short: string }[] = [
  { id: 'today', label: 'Today', short: 'Today' },
  { id: 'yesterday', label: 'Yesterday', short: 'Yesterday' },
  { id: '7d', label: 'Last 7 days', short: '7 days' },
  { id: '14d', label: 'Last 14 days', short: '14 days' },
  { id: '30d', label: 'Last 30 days', short: '30 days' },
  { id: 'thisMonth', label: 'This month', short: 'This month' },
  { id: 'lastMonth', label: 'Last month', short: 'Last month' },
];

/** Absolute bounds for a preset, resolved against "now" at call time. */
export const resolvePreset = (id: PresetId): { from: Date; to: Date } => {
  const now = new Date();
  const today = startOfDay(now);
  switch (id) {
    case 'today':
      return { from: today, to: endOfDay(now) };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: endOfDay(y) };
    }
    case '7d':
      return { from: addDays(today, -6), to: endOfDay(now) };
    case '14d':
      return { from: addDays(today, -13), to: endOfDay(now) };
    case '30d':
      return { from: addDays(today, -29), to: endOfDay(now) };
    case 'thisMonth':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) };
    case 'lastMonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: first, to: endOfDay(last) };
    }
    default:
      return { from: today, to: endOfDay(now) };
  }
};

export const defaultFilter = (): DashFilter => ({
  preset: 'today',
  ...resolvePreset('today'),
  agentId: null,
});

export const DashFilterContext = createContext<DashFilter>(defaultFilter());

const HOUR = 3600 * 1000;

export type FilterWindow = {
  /** Hours from now back to `from` — what the hooks take as `sinceHours`. */
  sinceHours: number;
  /** Hours from now back to `to`. 0 when the range runs up to the present. */
  untilHours: number;
  /** Whole days the range spans, at least 1. */
  days: number;
  /** Hour buckets the range spans, at least 1. */
  hours: number;
  from: Date;
  to: Date;
  agentId: string | null;
  /** True when the range ends now — i.e. the numbers are current, not historic.
   *  Panels use this to decide whether a "live" reading still makes sense. */
  isLive: boolean;
  /** True when the range covers one day or less, so hour buckets read better
   *  than day buckets. */
  isIntraday: boolean;
  /** Short human label for the window, for sub-labels like "· 7 days". */
  label: string;
};

/**
 * Converts the absolute filter into the relative window the data hooks want.
 * `to` is clamped to now: asking a hook for a window that ends in the future
 * would make untilHours negative and shift the whole range forward.
 */
export function useFilterWindow(): FilterWindow {
  const filter = useContext(DashFilterContext);
  const now = Date.now();
  const toMs = Math.min(filter.to.getTime(), now);
  const fromMs = Math.min(filter.from.getTime(), toMs);

  const sinceHours = Math.max(1, Math.ceil((now - fromMs) / HOUR));
  const untilHours = Math.max(0, Math.floor((now - toMs) / HOUR));
  const spanHours = Math.max(1, Math.ceil((toMs - fromMs) / HOUR));
  const days = Math.max(
    1,
    Math.round((endOfDay(filter.to).getTime() - startOfDay(filter.from).getTime()) / (24 * HOUR)),
  );

  const preset = PRESETS.find((p) => p.id === filter.preset);
  const label =
    preset?.short ??
    `${filter.from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${filter.to.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;

  return {
    sinceHours,
    untilHours,
    days,
    hours: spanHours,
    from: new Date(fromMs),
    to: new Date(toMs),
    agentId: filter.agentId,
    isLive: now - toMs < HOUR,
    isIntraday: days <= 1,
    label,
  };
}
