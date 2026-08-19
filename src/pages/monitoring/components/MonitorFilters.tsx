import type { ReactNode } from 'react';
import type { UiAgent } from '@/lib/dataHooks';

/* One filter row for every monitoring tab.

   Each of the five data tabs had its own copy of this: the same agent <select>,
   the same search box, and in two cases the same four category chips — all with
   independently drifting classes (three different search-box paddings, two
   different chip colour maps). One component means one look, and the search
   field picks up the app's own input styling instead of a grey slab. */

export type CategoryFilter = 'all' | 'productive' | 'unproductive' | 'neutral';

const CATEGORIES: { value: CategoryFilter; label: string; tone?: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'productive', label: 'Productive', tone: 'var(--d-success)' },
  { value: 'neutral', label: 'Neutral', tone: 'var(--d-neutral)' },
  { value: 'unproductive', label: 'Unproductive', tone: 'var(--d-danger)' },
];

type Props = {
  agents: UiAgent[];
  agentFilter: string;
  onAgentChange: (id: string) => void;
  search: string;
  onSearchChange: (q: string) => void;
  searchPlaceholder: string;
  /** Omit to hide the productive/unproductive chips. */
  category?: CategoryFilter;
  onCategoryChange?: (c: CategoryFilter) => void;
  /** Extra chips a tab needs (screenshot triggers, for example). */
  leading?: ReactNode;
  /** Row count summary, right-aligned before the controls. */
  count?: ReactNode;
};

export default function MonitorFilters({
  agents,
  agentFilter,
  onAgentChange,
  search,
  onSearchChange,
  searchPlaceholder,
  category,
  onCategoryChange,
  leading,
  count,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2 justify-between">
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        {leading}
        {category !== undefined && onCategoryChange && (
          <div className="seg">
            {CATEGORIES.map((c) => (
              <button
                key={c.value}
                onClick={() => onCategoryChange(c.value)}
                className={`seg-btn ${category === c.value ? 'is-on' : ''}`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {c.tone && (
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: c.tone }}
                    />
                  )}
                  {c.label}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {count}
        <select
          value={agentFilter}
          onChange={(e) => onAgentChange(e.target.value)}
          className="filter-date"
          style={{ minWidth: 132 }}
          aria-label="Filter by agent"
        >
          <option value="all">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <label className="field" style={{ minWidth: 200 }}>
          <i className="ri-search-line text-[12px] t3" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full text-[11.5px]"
          />
          {search && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="t3 hover:opacity-70"
              aria-label="Clear search"
            >
              <i className="ri-close-line text-[12px]" />
            </button>
          )}
        </label>
      </div>
    </div>
  );
}
