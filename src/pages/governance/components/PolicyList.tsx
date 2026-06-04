import type { GovPolicy } from '../types';

// Section 6 — Numbered policy list (P01..P08). Renders the policies the org
// has enabled with a small "enforced by" sub-line.

interface Props {
  policies: GovPolicy[];
  onEditPolicy?: (policyId: string) => void;
  onAddPolicy?: () => void;
}

export default function PolicyList({ policies, onEditPolicy, onAddPolicy }: Props) {
  if (policies.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-dark-700 bg-dark-900/40 p-6 text-center text-sm text-gray-500">
        No policies yet. Click <strong>Seed defaults</strong> to load the 8-policy template.
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {onAddPolicy && (
        <div className="flex justify-end mb-2">
          <button onClick={onAddPolicy} className="text-xs text-emerald-400 hover:text-emerald-300">+ Add policy</button>
        </div>
      )}
      <ul className="divide-y divide-dark-700 rounded-xl border border-dark-700 bg-dark-900/30">
        {policies
          .filter((p) => p.is_active)
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((p) => (
            <li key={p.id} className="flex gap-4 items-start px-5 py-3">
              <span className="font-mono text-[10px] font-semibold text-emerald-400 min-w-[28px] pt-[2px]">{p.code}</span>
              <span className="flex-1 text-sm text-gray-200">{p.body}</span>
              {p.enforced_by && (
                <span className="text-[10px] uppercase tracking-wider text-gray-500 pt-[2px]">{p.enforced_by}</span>
              )}
              {onEditPolicy && (
                <button onClick={() => onEditPolicy(p.id)} className="text-xs text-emerald-400 hover:text-emerald-300 pt-[2px]">Edit</button>
              )}
            </li>
          ))}
      </ul>
    </div>
  );
}
