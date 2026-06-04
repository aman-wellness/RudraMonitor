// Managers page — admin-facing view of who manages whom.
//   • Top section: anyone in the org who currently has at least one direct
//     report. Click → drawer with their team + actions.
//   • Bottom section: every other user (potential managers — assign them
//     reports to make them one).
//   • Bulk "Assign reports" modal: pick a manager → multi-select reports →
//     one POST applies the change for all selected via manager-assign-reports.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';

type OrgUser = {
  row_id: string;
  org_id: string;
  display_name: string;
  work_email: string | null;
  designation: string | null;
  department_id: string | null;
  manager_id: string | null;
  status: string;
  provider: 'm365' | 'google' | null;
  employee_id: string | null;
  m365_user_id: string | null;
  google_user_id: string | null;
  has_we_record: boolean;
};
type Department = { id: string; name: string };

export default function ManagersPage() {
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [activeManager, setActiveManager] = useState<(OrgUser & { team_size: number }) | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: u }, { data: d }] = await Promise.all([
      supabase.from('v_org_users').select('*').neq('status', 'offboarded').order('display_name'),
      supabase.from('org_departments').select('id, name').order('name'),
    ]);
    setUsers((u ?? []) as OrgUser[]);
    setDepts((d ?? []) as Department[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const deptName = useMemo(() => {
    const m = new Map(depts.map((x) => [x.id, x.name]));
    return (id: string | null) => (id ? m.get(id) ?? '—' : '—');
  }, [depts]);

  // Team-size map: count active users whose manager_id points at this employees.id.
  const teamSizeByEmpId = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of users) {
      if (!u.manager_id) continue;
      m.set(u.manager_id, (m.get(u.manager_id) ?? 0) + 1);
    }
    return m;
  }, [users]);

  const withTeamSize = useMemo(() => users.map((u) => ({
    ...u,
    team_size: u.employee_id ? (teamSizeByEmpId.get(u.employee_id) ?? 0) : 0,
  })), [users, teamSizeByEmpId]);

  const matchesQuery = (u: OrgUser) => {
    const ql = q.trim().toLowerCase();
    if (!ql) return true;
    return [u.display_name, u.work_email, u.designation].filter(Boolean).join(' ').toLowerCase().includes(ql);
  };

  const managers = useMemo(() => withTeamSize.filter((u) => u.team_size > 0 && matchesQuery(u)), [withTeamSize, q]);
  const nonManagers = useMemo(() => withTeamSize.filter((u) => u.team_size === 0 && matchesQuery(u)), [withTeamSize, q]);

  const totalReports = useMemo(() => withTeamSize.reduce((acc, u) => acc + u.team_size, 0), [withTeamSize]);
  const orphans = useMemo(
    () => withTeamSize.filter((u) => !u.manager_id && u.status === 'active').length,
    [withTeamSize],
  );

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
          <div>
            <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">Managers</h1>
            <p className="text-sm text-gray-400">
              Designate any user as a manager by assigning reports. Used for credential-request routing and offboarding sign-off.
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/employees" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white">Back to employees</Link>
            <button onClick={() => setBulkOpen(true)} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">
              <i className="ri-team-line mr-1" /> Assign reports to a manager
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
          <StatCard label="Managers" value={managers.length} accent="text-emerald-400" icon="ri-user-star-line" />
          <StatCard label="Reports across teams" value={totalReports} accent="text-blue-400" icon="ri-group-line" />
          <StatCard label="Unassigned (no manager)" value={orphans} accent={orphans > 0 ? 'text-amber-400' : 'text-gray-400'} icon="ri-question-line" />
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl mb-5">
          <div className="px-4 py-3 border-b border-dark-700 flex items-center gap-3">
            <div className="flex-1 flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5">
              <i className="ri-search-line text-gray-500 text-sm mr-2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, designation…"
                className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none flex-1" />
            </div>
          </div>

          <ManagersTable
            title={`Current managers (${managers.length})`}
            rows={managers}
            loading={loading}
            deptName={deptName}
            onPick={setActiveManager}
            emptyMessage="No managers yet. Click 'Assign reports to a manager' to designate someone."
          />
        </div>

        <details className="bg-dark-800 border border-dark-700 rounded-xl">
          <summary className="px-4 py-3 cursor-pointer text-sm text-white">
            Everyone else ({nonManagers.length}) — eligible to become a manager
          </summary>
          <ManagersTable
            title=""
            rows={nonManagers}
            loading={loading}
            deptName={deptName}
            onPick={setActiveManager}
            emptyMessage="—"
          />
        </details>
      </div>

      {activeManager && (
        <TeamDrawer
          manager={activeManager}
          allUsers={withTeamSize}
          onClose={() => setActiveManager(null)}
          onChanged={load}
        />
      )}

      {bulkOpen && (
        <BulkAssignModal
          users={withTeamSize}
          onClose={() => setBulkOpen(false)}
          onDone={async () => { setBulkOpen(false); await load(); }}
        />
      )}
    </DashboardLayout>
  );
}

// ============== Sub-components ==============

function StatCard({ label, value, accent, icon }: { label: string; value: number; accent: string; icon: string }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <i className={`${icon} ${accent}`} />
        <p className="text-xs text-gray-400 uppercase tracking-wider">{label}</p>
      </div>
      <p className={`text-2xl font-semibold ${accent}`}>{value}</p>
    </div>
  );
}

function ManagersTable({
  title, rows, loading, deptName, onPick, emptyMessage,
}: {
  title: string;
  rows: (OrgUser & { team_size: number })[];
  loading: boolean;
  deptName: (id: string | null) => string;
  onPick: (u: OrgUser & { team_size: number }) => void;
  emptyMessage: string;
}) {
  return (
    <div className="overflow-x-auto">
      {title && (
        <p className="px-4 py-2 text-xs text-gray-500 uppercase tracking-wider">{title}</p>
      )}
      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500 uppercase tracking-wider">
          <tr className="border-b border-dark-700">
            <th className="px-4 py-3 text-left font-medium">Name</th>
            <th className="px-4 py-3 text-left font-medium">Designation</th>
            <th className="px-4 py-3 text-left font-medium">Department</th>
            <th className="px-4 py-3 text-right font-medium">Team size</th>
            <th className="px-4 py-3 text-right font-medium" />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">{emptyMessage}</td></tr>
          ) : rows.map((u) => (
            <tr key={u.row_id} className="border-b border-dark-700/50 hover:bg-dark-700/30">
              <td className="px-4 py-3 text-white">
                {u.display_name}
                <div className="text-xs text-gray-500">{u.work_email ?? '—'}</div>
              </td>
              <td className="px-4 py-3 text-gray-300">{u.designation ?? '—'}</td>
              <td className="px-4 py-3 text-gray-300">{deptName(u.department_id)}</td>
              <td className="px-4 py-3 text-right">
                {u.team_size > 0 ? (
                  <span className="text-xs px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-400">{u.team_size}</span>
                ) : (
                  <span className="text-xs text-gray-500">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <button onClick={() => onPick(u)} className="text-xs text-emerald-400 hover:text-emerald-300">
                  {u.team_size > 0 ? 'View team →' : 'Assign reports →'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============== Team drawer (per manager) ==============

function TeamDrawer({
  manager, allUsers, onClose, onChanged,
}: {
  manager: OrgUser & { team_size: number };
  allUsers: (OrgUser & { team_size: number })[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const team = useMemo(
    () => allUsers.filter((u) => u.manager_id && u.manager_id === manager.employee_id),
    [allUsers, manager.employee_id],
  );

  const callMutate = async (managerRowId: string, reportRowIds: string[]) => {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manager-assign-reports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manager_row_id: managerRowId, report_row_ids: reportRowIds }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      const failed = (j.outcomes as Array<{ ok: boolean; error?: string }>).filter((x) => !x.ok);
      if (failed.length) setErr(`${failed.length} of ${reportRowIds.length} failed: ${failed.slice(0, 3).map((f) => f.error).join('; ')}`);
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <aside className="w-full max-w-md bg-dark-800 border-l border-dark-700 overflow-y-auto">
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Manager</p>
            <h2 className="text-lg text-white font-semibold truncate">{manager.display_name}</h2>
            <p className="text-xs text-gray-500 truncate">{manager.work_email ?? '—'}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>

        <div className="p-5 space-y-4">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

          <div className="flex items-center justify-between">
            <p className="text-sm text-white font-medium">Direct reports ({team.length})</p>
            <button onClick={() => setAddOpen(true)} className="text-xs text-emerald-400 hover:text-emerald-300">
              <i className="ri-add-line mr-1" /> Add reports
            </button>
          </div>

          {team.length === 0 ? (
            <p className="text-xs text-gray-500">No reports yet. Click "Add reports" to designate this user as a manager.</p>
          ) : (
            <ul className="space-y-1">
              {team.map((u) => (
                <li key={u.row_id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-dark-900/60 rounded-lg">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{u.display_name}</p>
                    <p className="text-xs text-gray-500 truncate">{u.work_email ?? '—'}{u.designation ? ` · ${u.designation}` : ''}</p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => callMutate('', [u.row_id])}
                    className="text-xs text-rose-400 hover:text-rose-300 disabled:opacity-30"
                  >Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {addOpen && (
          <AddReportsModal
            manager={manager}
            candidates={allUsers.filter((u) =>
              u.row_id !== manager.row_id &&                       // not self
              (!u.manager_id || u.manager_id !== manager.employee_id) // not already on this team
            )}
            onClose={() => setAddOpen(false)}
            onConfirm={async (rowIds) => {
              setAddOpen(false);
              await callMutate(manager.row_id, rowIds);
            }}
          />
        )}
      </aside>
    </div>
  );
}

function AddReportsModal({
  manager, candidates, onClose, onConfirm,
}: {
  manager: OrgUser & { team_size: number };
  candidates: (OrgUser & { team_size: number })[];
  onClose: () => void;
  onConfirm: (rowIds: string[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return candidates;
    return candidates.filter((u) =>
      [u.display_name, u.work_email, u.designation].filter(Boolean).join(' ').toLowerCase().includes(ql),
    );
  }, [candidates, q]);

  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-lg max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700">
          <h2 className="text-lg text-white font-semibold">Add reports to {manager.display_name}</h2>
          <p className="text-xs text-gray-500 mt-0.5">Selected users will report to this manager. If they already had a manager, they'll be moved.</p>
        </header>
        <div className="p-5 space-y-3 overflow-y-auto">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users…"
            className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600" />
          <div className="border border-dark-700 rounded-lg max-h-80 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-gray-500">No users match.</p>
            ) : filtered.map((u) => (
              <label key={u.row_id} className="flex items-center gap-3 px-3 py-2 border-b border-dark-700/50 hover:bg-dark-700/30 cursor-pointer">
                <input type="checkbox" checked={picked.has(u.row_id)} onChange={() => toggle(u.row_id)} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{u.display_name}</p>
                  <p className="text-xs text-gray-500 truncate">{u.work_email ?? '—'}{u.designation ? ` · ${u.designation}` : ''}</p>
                </div>
                {u.manager_id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">will move</span>}
              </label>
            ))}
          </div>
        </div>
        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
          <button
            disabled={picked.size === 0}
            onClick={() => onConfirm([...picked])}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
            Assign {picked.size} report{picked.size === 1 ? '' : 's'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ============== Top-level bulk modal (pick manager + reports together) ==============

function BulkAssignModal({
  users, onClose, onDone,
}: {
  users: (OrgUser & { team_size: number })[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [managerRowId, setManagerRowId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const candidates = useMemo(
    () => users.filter((u) => u.row_id !== managerRowId),
    [users, managerRowId],
  );
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return candidates;
    return candidates.filter((u) =>
      [u.display_name, u.work_email, u.designation].filter(Boolean).join(' ').toLowerCase().includes(ql),
    );
  }, [candidates, q]);

  const submit = async () => {
    if (!managerRowId || picked.size === 0) return;
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manager-assign-reports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manager_row_id: managerRowId, report_row_ids: [...picked] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      const failed = (j.outcomes as Array<{ ok: boolean; error?: string }>).filter((x) => !x.ok);
      if (failed.length) setErr(`${failed.length} of ${picked.size} failed: ${failed.slice(0, 3).map((f) => f.error).join('; ')}`);
      else { await onDone(); return; }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700">
          <h2 className="text-lg text-white font-semibold">Assign reports to a manager</h2>
          <p className="text-xs text-gray-500 mt-0.5">Pick the manager and the users that should report to them.</p>
        </header>
        <div className="p-5 space-y-3 overflow-y-auto">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Manager</span>
            <select value={managerRowId} onChange={(e) => { setManagerRowId(e.target.value); setPicked(new Set()); }}
              className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white">
              <option value="">— pick manager —</option>
              {users.map((u) => (
                <option key={u.row_id} value={u.row_id}>
                  {u.display_name}{u.work_email ? ` · ${u.work_email}` : ''}{u.team_size > 0 ? ` (already manages ${u.team_size})` : ''}
                </option>
              ))}
            </select>
          </label>

          {managerRowId && (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter reports…"
                className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600" />
              <div className="border border-dark-700 rounded-lg max-h-80 overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-gray-500">No users match.</p>
                ) : filtered.map((u) => (
                  <label key={u.row_id} className="flex items-center gap-3 px-3 py-2 border-b border-dark-700/50 hover:bg-dark-700/30 cursor-pointer">
                    <input type="checkbox" checked={picked.has(u.row_id)} onChange={() => {
                      setPicked((s) => {
                        const n = new Set(s);
                        if (n.has(u.row_id)) n.delete(u.row_id); else n.add(u.row_id);
                        return n;
                      });
                    }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{u.display_name}</p>
                      <p className="text-xs text-gray-500 truncate">{u.work_email ?? '—'}{u.designation ? ` · ${u.designation}` : ''}</p>
                    </div>
                    {u.manager_id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">will move</span>}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <footer className="px-5 py-3 border-t border-dark-700 flex items-center justify-between">
          <p className="text-xs text-gray-500">{picked.size} report{picked.size === 1 ? '' : 's'} selected</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
            <button onClick={submit} disabled={!managerRowId || picked.size === 0 || busy}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
              {busy ? 'Assigning…' : `Assign ${picked.size}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
