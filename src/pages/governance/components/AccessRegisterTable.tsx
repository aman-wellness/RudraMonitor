import { useMemo } from 'react';
import type { GovAccessRegister, GovPillarPlatform, OrgUser } from '../types';
import { RolePill } from './Pill';

// Section 5 — Per-platform individual access register. Groups rows by
// platform so each platform gets its own sub-table (matches the source doc).

interface Props {
  rows: GovAccessRegister[];
  platforms: GovPillarPlatform[];
  userById: Map<string, OrgUser>;
  onMarkReviewed?: (rowIds: string[]) => void;
  onEditRow?: (rowId: string) => void;
}

const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;

function formatDate(iso: string | null): string {
  if (!iso) return '__/__/__';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function isOverdue(iso: string | null): boolean {
  if (!iso) return true;            // never reviewed = overdue
  return Date.now() - new Date(iso).getTime() > SIX_MONTHS_MS;
}

export default function AccessRegisterTable({ rows, platforms, userById, onMarkReviewed, onEditRow }: Props) {
  // Group rows by platform_id, in the same order as platforms list.
  const grouped = useMemo(() => {
    const byPlatform = new Map<string, GovAccessRegister[]>();
    for (const r of rows) {
      const arr = byPlatform.get(r.platform_id) ?? [];
      arr.push(r);
      byPlatform.set(r.platform_id, arr);
    }
    return platforms
      .map((p) => ({ platform: p, items: (byPlatform.get(p.id) ?? []).sort((a, b) => a.sort_order - b.sort_order) }))
      .filter((g) => g.items.length > 0);
  }, [rows, platforms]);

  const overdueCount = rows.filter((r) => isOverdue(r.last_reviewed_at)).length;

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-dark-700 bg-dark-900/40 p-6 text-center text-sm text-gray-500">
        No access entries yet. Per Policy P08, this register is reviewed every 6 months.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {overdueCount > 0 && (
        <div className="rounded-lg border-l-4 border-amber-500 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          <strong>{overdueCount}</strong> {overdueCount === 1 ? 'entry has' : 'entries have'} not been reviewed in 6+ months (per Policy P08).
        </div>
      )}
      {grouped.map(({ platform, items }) => (
        <div key={platform.id} className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-[10px] font-semibold tracking-wider uppercase text-gray-500">{platform.platform_name}</h4>
            {onMarkReviewed && items.length > 0 && (
              <button
                onClick={() => onMarkReviewed(items.map((i) => i.id))}
                className="text-xs text-emerald-400 hover:text-emerald-300"
              >
                Mark all reviewed
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border border-dark-700">
            <table className="w-full text-sm">
              <thead className="bg-dark-800/60">
                <tr className="text-left text-[10px] uppercase tracking-wider text-gray-400">
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Email / Access</th>
                  <th className="px-4 py-2 w-24">Access Level</th>
                  <th className="px-4 py-2 w-32">Last Reviewed</th>
                  {onEditRow && <th className="px-4 py-2 w-12" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-700 bg-dark-900/30">
                {items.map((row) => {
                  const u = row.employee_id ? userById.get(row.employee_id) : null;
                  const overdue = isOverdue(row.last_reviewed_at);
                  return (
                    <tr key={row.id} className="hover:bg-dark-800/40">
                      <td className="px-4 py-2 text-gray-300">{row.role_label}</td>
                      <td className="px-4 py-2 text-gray-200">
                        {u?.display_name ?? <span className="text-amber-400 italic">Hiring</span>}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <span className="inline-block font-mono text-[11px] bg-blue-500/10 text-blue-300 border border-blue-500/20 rounded px-2 py-[2px]">
                          {row.email_format ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2"><RolePill role={row.access_level} /></td>
                      <td className={`px-4 py-2 text-xs ${overdue ? 'text-amber-400' : 'text-gray-400'}`}>
                        {formatDate(row.last_reviewed_at)}
                      </td>
                      {onEditRow && (
                        <td className="px-4 py-2 text-right">
                          <button onClick={() => onEditRow(row.id)} className="text-emerald-400 hover:text-emerald-300 text-xs">Edit</button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
