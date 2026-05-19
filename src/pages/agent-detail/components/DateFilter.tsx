// Date filter for the agent-detail page. Two modes:
//   • Quick presets: Today / Yesterday / 7 days / 30 days / All time
//   • Custom range: click the calendar pill → popover with two datetime-local
//     inputs + Apply. Choosing a custom range flips the active chip to
//     "Custom" and emits a range string the parent can decode.
//
// The previous version had a hard-coded "May 07, 00:00 → May 07, 10:05" pill
// that did absolutely nothing. This version actually works.

import { useEffect, useMemo, useRef, useState } from 'react';

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
  if (!d) return 'beginning';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) +
         ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
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
      alert('From date must be before To date.');
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
    <div className="relative flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1 bg-dark-900 rounded-lg p-1 overflow-x-auto">
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => handlePreset(p)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
              active === p ? 'bg-dark-700 text-white shadow-sm' : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            {p}
          </button>
        ))}
        {active === 'Custom' && (
          <span className="px-3 py-1.5 rounded-md text-xs font-medium bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
            Custom
          </span>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={openPicker}
          className="flex items-center bg-dark-800 hover:bg-dark-700 border border-dark-700 hover:border-dark-600 rounded-lg px-3 py-1.5 gap-2 text-xs text-gray-300 transition-colors"
          title="Click to pick a custom date range"
        >
          <i className="ri-calendar-line" />
          <span>{fmt(range.from)}</span>
          <span className="text-gray-600">→</span>
          <span>{fmt(range.to)}</span>
          <i className={`ri-arrow-${pickerOpen ? 'up' : 'down'}-s-line text-gray-500`} />
        </button>

        {pickerOpen && (
          <div ref={popoverRef}
            className="absolute right-0 top-full mt-2 z-30 w-[320px] bg-dark-800 border border-dark-700 rounded-xl shadow-2xl p-4 space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-gray-500">Custom range</p>
            <label className="block">
              <span className="text-[11px] text-gray-400 block mb-1">From</span>
              <input
                type="datetime-local"
                value={customFrom ? toLocalInput(customFrom) : ''}
                onChange={(e) => setCustomFrom(e.target.value ? new Date(e.target.value) : null)}
                className="w-full px-3 py-2 rounded-lg bg-dark-900 border border-dark-700 text-sm text-white focus:outline-none focus:border-cyan-500/50"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-gray-400 block mb-1">To</span>
              <input
                type="datetime-local"
                value={customTo ? toLocalInput(customTo) : ''}
                onChange={(e) => setCustomTo(e.target.value ? new Date(e.target.value) : null)}
                className="w-full px-3 py-2 rounded-lg bg-dark-900 border border-dark-700 text-sm text-white focus:outline-none focus:border-cyan-500/50"
              />
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={() => setPickerOpen(false)}
                className="px-3 py-1.5 rounded-md text-xs text-gray-400 hover:text-white">
                Cancel
              </button>
              <button onClick={applyCustom}
                disabled={!customFrom || !customTo}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-white">
                Apply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
