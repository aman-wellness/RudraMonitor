// Date filter for the agent-detail page. Two modes:
//   • Quick presets: Today / Yesterday / 7 days / 30 days / All time
//   • Custom range: click the calendar pill → popover with two datetime-local
//     inputs + Apply. Choosing a custom range flips the active chip to
//     "Custom" and emits a range string the parent can decode.
//
// Collapsed into a single button so it can share the header row with the agent's
// identity instead of taking a row of its own.

import { useEffect, useMemo, useRef, useState } from 'react';
import { notify } from '@/lib/notify';

const presets = ['Today', 'Yesterday', '7 days', '30 days', 'All time'] as const;
type Preset = typeof presets[number];

interface Props {
  /** Emits one of the preset values OR a "custom:<fromISO>|<toISO>" string. */
  onChange: (range: string) => void;
}

function computeRange(active: Preset | 'Custom', from?: Date, to?: Date): { from: Date | null; to: Date } {
  const now = new Date();
  switch (active) {
    case 'Today': {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      return { from: start, to: now };
    }
    case 'Yesterday': {
      const start = new Date(now); start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0);
      const end = new Date(start); end.setHours(23, 59, 59, 999);
      return { from: start, to: end };
    }
    case '7 days': {
      const start = new Date(now); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
      return { from: start, to: now };
    }
    case '30 days': {
      const start = new Date(now); start.setDate(start.getDate() - 29); start.setHours(0, 0, 0, 0);
      return { from: start, to: now };
    }
    case 'All time':
      return { from: null, to: now };
    case 'Custom':
      return { from: from ?? null, to: to ?? now };
  }
}

function fmt(d: Date | null): string {
  if (!d) return 'the beginning';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Helper: convert a Date into the "YYYY-MM-DDTHH:MM" string the
// datetime-local input wants (local-zone, no Z suffix).
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function DateFilter({ onChange }: Props) {
  const [active, setActive] = useState<Preset | 'Custom'>('Today');
  const [customFrom, setCustomFrom] = useState<Date | null>(null);
  const [customTo,   setCustomTo]   = useState<Date | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close the popover when the user clicks outside or hits Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [pickerOpen]);

  // The effective range the pill displays. Recomputed every render against
  // wall-clock time so "Today" stays in sync as the day rolls over.
  const range = useMemo(
    () => computeRange(active, customFrom ?? undefined, customTo ?? undefined),
    [active, customFrom, customTo],
  );

  const handlePreset = (p: Preset) => {
    setActive(p);
    onChange(p);
  };

  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    if (customFrom > customTo) {
      notify.error('From date must be before To date.');
      return;
    }
    setActive('Custom');
    onChange(`custom:${customFrom.toISOString()}|${customTo.toISOString()}`);
    setPickerOpen(false);
  };

  const openPicker = () => {
    // Seed the inputs with the currently-active range so the user starts
    // editing from the same window they're looking at.
    if (!customFrom || !customTo) {
      const seeded = computeRange(active === 'Custom' ? 'Today' : active);
      setCustomFrom(seeded.from ?? new Date(Date.now() - 86400000));
      setCustomTo(seeded.to);
    }
    setPickerOpen(true);
  };

  return (
    <span className="relative inline-flex" ref={popoverRef}>
      <button
        type="button"
        onClick={openPicker}
        className="filter-btn"
        aria-expanded={pickerOpen}
        title="Change the window these figures cover"
      >
        <i className="ri-calendar-line text-[13px] t3" />
        <span className="t1 font-medium">{active}</span>
        <span className="t3 hidden md:inline">
          {fmt(range.from)} → {fmt(range.to)}
        </span>
        <i className="ri-arrow-down-s-line text-[13px] t3" />
      </button>

      {pickerOpen && (
        <div className="filter-pop" style={{ left: 'auto', right: 0, top: 36, width: 262 }}>
          <div className="p-1">
            {presets.map((p) => (
              <button
                key={p}
                onClick={() => handlePreset(p)}
                className={`filter-opt ${active === p ? 'is-on' : ''}`}
              >
                <span className="flex-1 text-left">{p}</span>
                {active === p && <i className="ri-check-line text-[13px]" />}
              </button>
            ))}
          </div>

          <div className="p-2.5 hair-t space-y-2">
            <span className="label">Custom range</span>
            <label className="block">
              <span className="block text-[10px] t3 mb-1">From</span>
              <input
                type="datetime-local"
                value={customFrom ? toLocalInput(customFrom) : ''}
                onChange={(e) => setCustomFrom(e.target.value ? new Date(e.target.value) : null)}
                className="filter-date w-full"
              />
            </label>
            <label className="block">
              <span className="block text-[10px] t3 mb-1">To</span>
              <input
                type="datetime-local"
                value={customTo ? toLocalInput(customTo) : ''}
                onChange={(e) => setCustomTo(e.target.value ? new Date(e.target.value) : null)}
                className="filter-date w-full"
              />
            </label>
            <div className="flex items-center justify-end gap-2 pt-0.5">
              <button onClick={() => setPickerOpen(false)} className="dlg-btn" style={{ height: 26 }}>
                Cancel
              </button>
              <button
                onClick={applyCustom}
                disabled={!customFrom || !customTo}
                className="dlg-btn is-primary disabled:opacity-40"
                style={{ height: 26 }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
