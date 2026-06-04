import type { GovPillarSummary, GovPillarAssignment, OrgUser } from '../types';
import { PillarDot, StatusPill } from './Pill';

// Phase-2 read-only org tree. Renders a hand-rolled hierarchy:
//   Founder (org owner)
//   └── Pillars (one row each)
//       └── Members (editors / view roles)
//
// Phase 4 will swap this for an interactive react-flow chart. The data model
// is the same so the upgrade is component-internal.

interface Props {
  founderName: string | null;
  pillars: GovPillarSummary[];
  assignmentsByPillar: Map<string, GovPillarAssignment[]>;
  userById: Map<string, OrgUser>;
}

export default function OrgTree({ founderName, pillars, assignmentsByPillar, userById }: Props) {
  if (pillars.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-dark-700 bg-dark-900/40 p-6 text-center text-sm text-gray-500">
        No pillars yet. Seed defaults to render the org tree.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-dark-700 bg-dark-900/30 p-6 font-mono text-[12.5px] leading-7 text-gray-200 overflow-x-auto">
      <div className="text-white">
        <i className="ri-vip-crown-line mr-2 text-amber-300" />
        Founder / CEO {founderName && <span className="text-gray-400">({founderName})</span>}
      </div>
      {pillars.map((p, idx) => {
        const isLast = idx === pillars.length - 1;
        const branch = isLast ? '└──' : '├──';
        const assignments = assignmentsByPillar.get(p.id) ?? [];
        // Filter the people who report INTO this pillar (editor + view).
        const members = assignments.filter((a) => a.role === 'editor' || a.role === 'view');
        return (
          <div key={p.id} className="mt-1">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">{branch}</span>
              <PillarDot color={p.color} size={9} />
              <span className="font-semibold text-white">{p.name} Lead</span>
              {p.owner_name ? (
                <span className="text-gray-400">({p.owner_name})</span>
              ) : (
                <span className="text-amber-400">[Hiring]</span>
              )}
              {p.hiring_flag && <StatusPill status="hiring" />}
            </div>
            {members.map((m, midx) => {
              const u = userById.get(m.employee_id);
              const memberLast = midx === members.length - 1;
              const memberBranch = memberLast ? '└──' : '├──';
              const parentSpace = isLast ? '    ' : '│   ';
              return (
                <div key={m.id} className="flex items-center gap-2 pl-2">
                  <span className="text-gray-500">{parentSpace}{memberBranch}</span>
                  <span className="text-gray-300">{u?.display_name ?? '(unknown)'}</span>
                  {m.notes && <span className="text-gray-500 text-xs">— {m.notes}</span>}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
