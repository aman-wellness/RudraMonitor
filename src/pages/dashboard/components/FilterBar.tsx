import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgents } from '@/lib/dataHooks';
import {
  PRESETS,
  endOfDay,
  resolvePreset,
  startOfDay,
  type DashFilter,
  type PresetId,
} from '../filterContext';

/* Agent + date-range picker. Everything below it on the page reads from this.

   Two popovers rather than always-visible controls: the bar is chrome, not
   content, so it stays one line tall and doesn't compete with the KPI strip
   underneath. Both close on outside click and on Escape. */

const iso = (d: Date) => {
  // Local yyyy-mm-dd for <input type="date">; toISOString() would shift the day
  // for anyone east or west of UTC.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const fmt = (d: Date) =>
  d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });

function useDismiss(onClose: () => void, active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, onClose]);
  return ref;
}

export default function FilterBar({
  filter,
  onChange,
}: {
  filter: DashFilter;
  onChange: (next: DashFilter) => void;
}) {
  const { agents } = useAgents();
  const [agentOpen, setAgentOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [search, setSearch] = useState('');

  const agentRef = useDismiss(() => setAgentOpen(false), agentOpen);
  const dateRef = useDismiss(() => setDateOpen(false), dateOpen);

  const selected = agents.find((a) => a.id === filter.agentId) ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.machine.toLowerCase().includes(q) ||
        a.department.toLowerCase().includes(q),
    );
  }, [agents, search]);

  const rangeLabel =
    filter.preset === 'custom'
      ? `${fmt(filter.from)} – ${fmt(filter.to)}`
      : (PRESETS.find((p) => p.id === filter.preset)?.label ?? 'Custom');

  const setPreset = (id: PresetId) => {
    onChange({ ...filter, preset: id, ...resolvePreset(id) });
    setDateOpen(false);
  };

  // A custom edit keeps from <= to by pushing the other end along, so the range
  // can never invert mid-edit.
  const setFrom = (value: string) => {
    if (!value) return;
    const from = startOfDay(new Date(`${value}T00:00:00`));
    const to = from > filter.to ? endOfDay(from) : filter.to;
    onChange({ ...filter, preset: 'custom', from, to });
  };
  const setTo = (value: string) => {
    if (!value) return;
    const to = endOfDay(new Date(`${value}T00:00:00`));
    const from = to < filter.from ? startOfDay(to) : filter.from;
    onChange({ ...filter, preset: 'custom', from, to });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap mb-2.5">
      {/* ---------------------------------------------------------- agent ---- */}
      <div className="relative" ref={agentRef}>
        <button
          onClick={() => setAgentOpen((v) => !v)}
          className="filter-btn"
          aria-expanded={agentOpen}
          aria-haspopup="listbox"
        >
          <i className={`${selected ? 'ri-user-line' : 'ri-group-line'} text-[13px] t3`} />
          <span className="t1 font-medium truncate max-w-[150px]">
            {selected ? selected.name : 'All agents'}
          </span>
          <span className="t3">{selected ? '' : `· ${agents.length}`}</span>
          <i className="ri-arrow-down-s-line text-[13px] t3" />
        </button>

        {agentOpen && (
          <div className="filter-pop" style={{ width: 250 }} role="listbox">
            <div className="p-1.5 hair-b">
              <span className="field">
                <i className="ri-search-line text-[12px] t3" />
                <input
                  type="text"
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search agents"
                  className="w-full text-[11.5px]"
                />
              </span>
            </div>
            <div className="max-h-[260px] overflow-y-auto p-1">
              <button
                onClick={() => {
                  onChange({ ...filter, agentId: null });
                  setAgentOpen(false);
                }}
                className={`filter-opt ${filter.agentId === null ? 'is-on' : ''}`}
              >
                <i className="ri-group-line text-[13px]" />
                <span className="flex-1 text-left">All agents</span>
                <span className="t3 text-[10px]">{agents.length}</span>
              </button>
              {filtered.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    onChange({ ...filter, agentId: a.id });
                    setAgentOpen(false);
                  }}
                  className={`filter-opt ${filter.agentId === a.id ? 'is-on' : ''}`}
                >
                  <span
                    className={`live-dot ${a.status === 'online' ? '' : 'is-off'}`}
                    style={a.status === 'idle' ? { background: 'var(--d-warning)' } : undefined}
                  />
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block truncate">{a.name}</span>
                    <span className="block text-[9.5px] t3 truncate">{a.department}</span>
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="text-[11px] t3 text-center py-3">No agents match.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------- date ---- */}
      <div className="relative" ref={dateRef}>
        <button
          onClick={() => setDateOpen((v) => !v)}
          className="filter-btn"
          aria-expanded={dateOpen}
        >
          <i className="ri-calendar-line text-[13px] t3" />
          <span className="t1 font-medium">{rangeLabel}</span>
          <i className="ri-arrow-down-s-line text-[13px] t3" />
        </button>

        {dateOpen && (
          <div className="filter-pop" style={{ width: 250 }}>
            <div className="p-1">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPreset(p.id)}
                  className={`filter-opt ${filter.preset === p.id ? 'is-on' : ''}`}
                >
                  <span className="flex-1 text-left">{p.label}</span>
                  {filter.preset === p.id && <i className="ri-check-line text-[13px]" />}
                </button>
              ))}
            </div>
            <div className="p-2.5 hair-t space-y-2">
              <span className="label">Custom range</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={iso(filter.from)}
                  max={iso(filter.to)}
                  onChange={(e) => setFrom(e.target.value)}
                  className="filter-date"
                  aria-label="From date"
                />
                <span className="t3 text-[11px]">to</span>
                <input
                  type="date"
                  value={iso(filter.to)}
                  min={iso(filter.from)}
                  max={iso(new Date())}
                  onChange={(e) => setTo(e.target.value)}
                  className="filter-date"
                  aria-label="To date"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Reset appears only when something is actually filtered. */}
      {(filter.agentId !== null || filter.preset !== 'today') && (
        <button
          onClick={() =>
            onChange({ preset: 'today', ...resolvePreset('today'), agentId: null })
          }
          className="chip chip-quiet text-[10px]"
          title="Clear filters"
        >
          <i className="ri-close-line" />
          Reset
        </button>
      )}
    </div>
  );
}
