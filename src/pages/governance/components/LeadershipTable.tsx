import type { GovPillarSummary } from '../types';
import { PillarDot, StatusPill } from './Pill';

// Section 1 — Leadership Overview. One row per pillar showing owner, backup,
// reports-to, and seat status. Mirrors the doc's first table.

interface Props {
  pillars: GovPillarSummary[];
  reportsToLabel: (pillar: GovPillarSummary) => string;
  onEditPillar?: (pillarId: string) => void;
}

export default function LeadershipTable({ pillars, reportsToLabel, onEditPillar }: Props) {
  if (pillars.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-dark-700 bg-dark-900/40 p-10 text-center">
        <i className="ri-organization-chart text-3xl text-gray-600 mb-2 block" />
        <p className="text-gray-400 text-sm">
          No pillars yet. Click <strong>+ New pillar</strong> to add your own,
          or <strong>Load starter template</strong> for a 9-pillar marketing/ops example.
        </p>
        <p className="text-gray-500 text-xs mt-2">
          Tip: the Org Chart tab already shows your real reporting tree from <code className="text-emerald-400">employees → manager_id</code> — pillars are an optional layer on top.
        </p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-dark-700">
      <table className="w-full text-sm">
        <thead className="bg-dark-800/60">
          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-400">
            <th className="px-4 py-3">Pillar</th>
            <th className="px-4 py-3">Current Owner</th>
            <th className="px-4 py-3">Backup / Cover</th>
            <th className="px-4 py-3">Reports To</th>
            <th className="px-4 py-3">Seat Status</th>
            {onEditPillar && <th className="px-4 py-3 w-12" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-dark-700 bg-dark-900/30">
          {pillars.map((p) => (
            <tr key={p.id} className="hover:bg-dark-800/40">
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-2 font-semibold text-white">
                  <PillarDot color={p.color} size={9} />
                  {p.name}
                </span>
              </td>
              <td className="px-4 py-3 text-gray-200">
                {p.owner_name ?? <span className="text-gray-500 italic">—</span>}
              </td>
              <td className="px-4 py-3 text-gray-300">
                {p.backup_name ?? <span className="text-gray-500 italic">—</span>}
              </td>
              <td className="px-4 py-3 text-gray-400 text-xs">{reportsToLabel(p)}</td>
              <td className="px-4 py-3">
                <StatusPill status={p.hiring_flag ? 'hiring' : p.status} />
              </td>
              {onEditPillar && (
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => onEditPillar(p.id)}
                    className="text-emerald-400 hover:text-emerald-300 text-xs"
                  >
                    Edit
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
