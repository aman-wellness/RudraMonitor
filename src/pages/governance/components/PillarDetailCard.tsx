import type { GovPillar, GovPillarAssignment, GovPillarPlatform, OrgUser } from '../types';
import { PillarDot, RolePill, StatusPill } from './Pill';

// Section 4 — One detail card per pillar showing its platforms + access model
// + primary channel. Mirrors `.pillar-block` from the source HTML doc.

interface Props {
  pillar: GovPillar;
  platforms: GovPillarPlatform[];
  assignments: GovPillarAssignment[];
  userById: Map<string, OrgUser>;
  channelName?: string;
  onEditPillar?: () => void;
  onAssignRoles?: () => void;
  onAddPlatform?: () => void;
}

const ROLE_ORDER = { owner: 0, admin: 1, editor: 2, view: 3, external: 4 } as const;

export default function PillarDetailCard({
  pillar, platforms, assignments, userById, channelName,
  onEditPillar, onAssignRoles, onAddPlatform,
}: Props) {
  // Sort assignments by role rank, then by name.
  const sortedAssignments = [...assignments].sort((a, b) => {
    const r = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
    if (r !== 0) return r;
    const an = userById.get(a.employee_id)?.display_name ?? '';
    const bn = userById.get(b.employee_id)?.display_name ?? '';
    return an.localeCompare(bn);
  });

  return (
    <div className="rounded-xl border border-dark-700 bg-dark-900/40 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-dark-700 bg-dark-800/40">
        <PillarDot color={pillar.color} size={10} />
        <h3 className="font-semibold text-white">{pillar.name}</h3>
        {pillar.hiring_flag && <StatusPill status="hiring" />}
        {pillar.functions_desc && (
          <span className="ml-auto text-xs text-gray-500">{pillar.functions_desc}</span>
        )}
        {onEditPillar && (
          <button
            onClick={onEditPillar}
            className="ml-2 text-xs text-emerald-400 hover:text-emerald-300"
          >
            Edit
          </button>
        )}
      </div>
      {/* Body: 2-column grid (platforms | access model) */}
      <div className="grid md:grid-cols-2 gap-6 p-5">
        {/* LEFT — Platforms */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-[10px] font-semibold tracking-wider uppercase text-gray-500">Platforms &amp; Tools</h4>
            {onAddPlatform && (
              <button onClick={onAddPlatform} className="text-xs text-emerald-400 hover:text-emerald-300">+ Add</button>
            )}
          </div>
          {platforms.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No platforms documented yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-dark-700">
              <table className="w-full text-xs">
                <thead className="bg-dark-800/50 text-[9px] uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-2">Platform</th>
                    <th className="text-left px-3 py-2">Type / Access Method</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-700">
                  {platforms.map((p) => (
                    <tr key={p.id}>
                      <td className="px-3 py-2 text-gray-200">{p.platform_name}</td>
                      <td className="px-3 py-2 text-gray-400">{p.platform_type ?? p.access_method ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* RIGHT — Access Model + Channel */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-[10px] font-semibold tracking-wider uppercase text-gray-500">Access Model</h4>
            {onAssignRoles && (
              <button onClick={onAssignRoles} className="text-xs text-emerald-400 hover:text-emerald-300">+ Assign</button>
            )}
          </div>
          {sortedAssignments.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No one assigned yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-dark-700">
              <table className="w-full text-xs">
                <thead className="bg-dark-800/50 text-[9px] uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-2">Role</th>
                    <th className="text-left px-3 py-2 w-20">Access</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dark-700">
                  {sortedAssignments.map((a) => {
                    const u = userById.get(a.employee_id);
                    return (
                      <tr key={a.id}>
                        <td className="px-3 py-2 text-gray-200">
                          {u?.display_name ?? <span className="text-gray-500 italic">(unknown employee)</span>}
                          {a.is_acting && <span className="ml-2 text-[10px] text-amber-400">acting</span>}
                        </td>
                        <td className="px-3 py-2"><RolePill role={a.role} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {channelName && (
            <>
              <h4 className="text-[10px] font-semibold tracking-wider uppercase text-gray-500 mt-4 mb-2">Channel</h4>
              <span className="inline-flex items-center font-mono text-[12px] px-2 py-[3px] rounded border bg-dark-800/60 border-dark-700 text-gray-200">
                <span className="text-emerald-400 font-bold">#</span>
                {channelName.replace(/^#/, '')}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
