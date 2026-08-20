import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';
import Pager from '@/components/Pager';
import { usePagination } from '@/lib/usePagination';

// Row shape from the v_org_users view. row_id is synthetic: 'dir:<uuid>' for
// directory-sourced rows and 'emp:<uuid>' for Rudrans-only rows.
type Employee = {
  row_id: string;
  org_id: string;
  display_name: string;
  work_email: string | null;
  personal_email: string | null;
  designation: string | null;
  department_id: string | null;
  manager_id: string | null;
  doj: string | null;
  status: string;                       // 'active' | 'offboarding' | 'offboarded' | 'disabled' | …
  provider: 'm365' | 'google' | null;
  account_enabled: boolean | null;
  employee_id: string | null;
  m365_user_id: string | null;
  google_user_id: string | null;
  has_we_record: boolean;
  created_at: string;
};

type Department = { id: string; name: string };

export default function EmployeesList() {
  const [rows, setRows] = useState<Employee[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'offboarding' | 'offboarded' | 'disabled'>('all');
  const [deptFilter, setDeptFilter] = useState<'all' | string>('all');
  const [confirmDelete, setConfirmDelete] = useState<Employee | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleteCloud, setDeleteCloud] = useState(true);
  const [editing, setEditing] = useState<Employee | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: emp }, { data: dep }] = await Promise.all([
      supabase.from('v_org_users').select('*').order('display_name'),
      supabase.from('org_departments').select('id, name').order('name'),
    ]);
    setRows((emp ?? []) as Employee[]);
    setDepts((dep ?? []) as Department[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const deptName = useMemo(() => {
    const m = new Map(depts.map((d) => [d.id, d.name]));
    return (id: string | null) => (id ? m.get(id) ?? '—' : '—');
  }, [depts]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (deptFilter !== 'all' && r.department_id !== deptFilter) return false;
      if (!ql) return true;
      return [r.display_name, r.work_email, r.personal_email, r.designation]
        .filter(Boolean).join(' ').toLowerCase().includes(ql);
    });
  }, [rows, q, statusFilter, deptFilter]);

  // Fetched without a limit and grows with headcount, so this is one row per
  // employee with no ceiling.
  const { visible, page, pageCount, setPage, from, to, total } = usePagination(filtered, 50);

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
          <div>
            <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">Employees</h1>
            <p className="text-sm text-gray-400">Provision new joiners, manage existing accounts, kick off offboarding.</p>
          </div>
          <div className="flex gap-2">
            <Link to="/employees/integrations" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white font-medium">
              <i className="ri-plug-line mr-1" /> Integrations
            </Link>
            <Link to="/employees/groups" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white font-medium">
              <i className="ri-group-line mr-1" /> Groups
            </Link>
            <Link to="/employees/managers" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white font-medium">
              <i className="ri-user-star-line mr-1" /> Managers
            </Link>
            <Link to="/employees/hardware" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white font-medium">
              <i className="ri-computer-line mr-1" /> Hardware
            </Link>
            <AddEmployeeMenu />
          </div>
        </header>

        <div className="bg-dark-800 border border-dark-700 rounded-xl">
          <div className="p-4 flex flex-col md:flex-row gap-3 md:items-center border-b border-dark-700">
            <div className="flex-1 flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5">
              <i className="ri-search-line text-gray-500 text-sm mr-2" />
              <input
                value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, email, designation…"
                className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none flex-1"
              />
            </div>
            <select
              value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="offboarding">Offboarding</option>
              <option value="offboarded">Offboarded</option>
              <option value="disabled">Disabled</option>
            </select>
            <select
              value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}
              className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
            >
              <option value="all">All departments</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase tracking-wider">
                <tr className="border-b border-dark-700">
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium">Work email</th>
                  <th className="px-4 py-3 text-left font-medium">Designation</th>
                  <th className="px-4 py-3 text-left font-medium">Department</th>
                  <th className="px-4 py-3 text-left font-medium">Provisioned</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium w-12" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-500">Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-500">
                    No employees yet. <Link to="/employees/new/m365" className="text-emerald-400 hover:text-emerald-300">Add the first</Link>.
                  </td></tr>
                ) : visible.map((e) => (
                  <tr key={e.row_id} className="border-b border-dark-700/50 hover:bg-dark-700/30">
                    <td className="px-4 py-3 text-white">
                      {e.display_name}
                      {!e.has_we_record && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-400" title="Synced from M365/Google — not provisioned through Rudrans">synced</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-300">{e.work_email ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-300">{e.designation ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-300">{deptName(e.department_id)}</td>
                    <td className="px-4 py-3 text-gray-300">
                      <span className="inline-flex gap-1">
                        {e.m365_user_id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">M365</span>}
                        {e.google_user_id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">Google</span>}
                        {!e.m365_user_id && !e.google_user_id && <span className="text-gray-500">—</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={e.status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-3">
                        <button
                          onClick={() => setEditing(e)}
                          title="Edit HR metadata (manager, department, designation, …)"
                          className="text-gray-500 hover:text-emerald-400 transition-colors"
                        >
                          <i className="ri-pencil-line text-base" />
                        </button>
                        <button
                          onClick={() => { setConfirmDelete(e); setDeleteErr(null); }}
                          title="Delete user"
                          className="text-gray-500 hover:text-rose-400 transition-colors"
                        >
                          <i className="ri-delete-bin-line text-base" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 border-t border-dark-700">
            <Pager
              page={page} pageCount={pageCount} from={from} to={to} total={total}
              onPage={setPage} unit={`of ${rows.length} employees`} alwaysShowTotal
            />
          </div>
        </div>
      </div>

      {editing && (
        <EditEmployeeModal
          employee={editing}
          allEmployees={rows}
          departments={depts}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => !deleting && setConfirmDelete(null)}>
          <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-md" onClick={(ev) => ev.stopPropagation()}>
            <header className="px-5 py-4 border-b border-dark-700">
              <h2 className="text-lg text-white font-semibold">Delete employee?</h2>
            </header>
            <div className="p-5 space-y-3">
              <p className="text-sm text-gray-300">
                Remove <strong>{confirmDelete.display_name}</strong>{confirmDelete.work_email ? ` (${confirmDelete.work_email})` : ''}.
              </p>

              <label className="flex items-start gap-3 p-3 rounded-lg border border-dark-700 hover:bg-dark-700/30 cursor-pointer">
                <input type="checkbox" checked={deleteCloud} onChange={(e) => setDeleteCloud(e.target.checked)} className="mt-1" />
                <div className="flex-1">
                  <p className="text-sm text-white">Also delete the Microsoft 365 / Google Workspace user</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    The cloud accounts go to "Deleted users" — recoverable for 30 days (M365) / 20 days (Google) from the respective admin center.
                  </p>
                </div>
              </label>

              {deleteCloud && (confirmDelete.m365_user_id || confirmDelete.google_user_id) && (
                <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                  ⚠️ This will sign-out and remove the cloud account
                  {confirmDelete.m365_user_id && ' on Microsoft 365'}
                  {confirmDelete.m365_user_id && confirmDelete.google_user_id && ' and'}
                  {confirmDelete.google_user_id && ' on Google Workspace'}. Their mailbox / files will be retained per the provider's deleted-user policy. For a controlled exit with creds review + asset handover, use <strong>offboarding</strong> instead.
                </p>
              )}

              {deleteErr && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{deleteErr}</div>}
            </div>
            <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">
              <button disabled={deleting} onClick={() => setConfirmDelete(null)} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
              <button
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true); setDeleteErr(null);
                  try {
                    const { data: { session } } = await supabase.auth.getSession();
                    const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-employee`, {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        // Prefer employee_id when we have one (Rudrans record exists);
                        // otherwise identify the user by their cloud directory id.
                        ...(confirmDelete.employee_id
                          ? { employee_id: confirmDelete.employee_id }
                          : { provider: confirmDelete.provider, external_id: confirmDelete.m365_user_id ?? confirmDelete.google_user_id }),
                        delete_cloud_accounts: deleteCloud,
                      }),
                    });
                    const j = await r.json();
                    if (!r.ok) throw new Error(j.error ?? `${r.status}`);
                    setConfirmDelete(null);
                    await load();
                  } catch (e) {
                    setDeleteErr((e as Error).message);
                  } finally {
                    setDeleting(false);
                  }
                }}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium"
              >
                {deleting ? 'Deleting…' : 'Delete record'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active:      'bg-emerald-500/15 text-emerald-400',
    offboarding: 'bg-amber-500/15 text-amber-400',
    offboarded:  'bg-rose-500/15 text-rose-400',
    disabled:    'bg-gray-500/15 text-gray-400',
  };
  return <span className={`text-xs px-2 py-1 rounded-full ${map[status] ?? 'bg-dark-700 text-gray-300'}`}>{status}</span>;
}

// Split button: primary action goes to the M365 wizard (most common path);
// a small caret reveals the alternative flows (Google → coming soon; Local
// metadata only → routes to the legacy wizard which doesn't call Graph).
function AddEmployeeMenu() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDoc = () => setOpen(false);
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);

  return (
    <div className="relative inline-flex" onClick={(e) => e.stopPropagation()}>
      <Link
        to="/employees/new/m365"
        className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-l-lg text-sm text-white font-medium flex items-center gap-1.5"
      >
        <i className="ri-microsoft-line" /> Add Microsoft 365 user
      </Link>
      <button
        onClick={() => setOpen((x) => !x)}
        className="px-2 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-r-lg text-sm text-white border-l border-emerald-700"
        aria-label="More add options"
      >
        <i className="ri-arrow-down-s-line" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-dark-800 border border-dark-700 rounded-lg shadow-2xl z-50 overflow-hidden">
          <button
            disabled
            className="w-full text-left px-3 py-2 text-sm text-gray-500 cursor-not-allowed flex items-center gap-2"
            title="Google wizard coming next"
          >
            <i className="ri-google-line" /> Add Google Workspace user
            <span className="ml-auto text-[10px] text-gray-600">soon</span>
          </button>
          <Link
            to="/employees/new"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-white hover:bg-dark-700/50 flex items-center gap-2"
          >
            <i className="ri-database-2-line" /> Local record only
            <span className="ml-auto text-[10px] text-gray-500">no provisioning</span>
          </Link>
        </div>
      )}
    </div>
  );
}

// ============== Edit employee modal ==============
//
// Lets admins set HR-side fields on any user surfaced in /employees — Rudrans
// or directory-synced. For directory-only rows the edge fn auto-creates an
// employees row so the manager_id FK + future credential assignments have
// something to reference. work_email is read-only (source-of-truth is the
// provider; cloud changes flow back via directory-sync).

function EditEmployeeModal({
  employee, allEmployees, departments, onClose, onSaved,
}: {
  employee: Employee;
  allEmployees: Employee[];
  departments: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [fullName, setFullName] = useState(employee.display_name);
  const [designation, setDesignation] = useState(employee.designation ?? '');
  const [departmentId, setDepartmentId] = useState(employee.department_id ?? '');
  // Manager state is a synthetic row_id ('emp:<uuid>' or 'dir:<uuid>'), not a
  // raw employees.id — that lets us pick a directory-only user as manager and
  // have the backend lazily create their employees row at save time.
  const initialManagerRowId = useMemo(() => {
    if (!employee.manager_id) return '';
    const match = allEmployees.find((e) => e.employee_id === employee.manager_id);
    return match?.row_id ?? `emp:${employee.manager_id}`;
  }, [allEmployees, employee.manager_id]);
  const [managerRowId, setManagerRowId] = useState(initialManagerRowId);
  const [doj, setDoj] = useState(employee.doj ?? '');
  const [personalEmail, setPersonalEmail] = useState(employee.personal_email ?? '');
  const [status, setStatus] = useState(employee.status as string);
  // Contact-info fields (mirror Microsoft 365 "Manage contact information").
  // Loaded async from `employees` because v_org_users doesn't surface them.
  // While loading they stay empty; save() still works (untouched fields are
  // simply not included in the patch).
  const [officeLocation, setOfficeLocation] = useState('');
  const [officePhone, setOfficePhone]       = useState('');
  const [faxNumber, setFaxNumber]           = useState('');
  const [mobilePhone, setMobilePhone]       = useState('');
  const [streetAddress, setStreetAddress]   = useState('');
  const [city, setCity]                     = useState('');
  const [stateProvince, setStateProvince]   = useState('');
  const [postalCode, setPostalCode]         = useState('');
  const [country, setCountry]               = useState('');
  const [contactLoaded, setContactLoaded]   = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Pull the long-form contact fields straight from `employees`. They're not
  // on v_org_users to keep the list query lean, but the edit modal needs
  // them so the customer can review + edit what's currently on the M365
  // user's contact form. If the employee doesn't have a Rudrans row yet
  // (directory-only), seed from directory_users instead.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (employee.employee_id) {
        const { data } = await supabase
          .from('employees')
          .select('office_location, office_phone, fax_number, mobile_phone, street_address, city, state_province, postal_code, country')
          .eq('id', employee.employee_id)
          .maybeSingle();
        if (cancelled || !data) { setContactLoaded(true); return; }
        const e = data as Record<string, string | null>;
        setOfficeLocation(e.office_location ?? '');
        setOfficePhone(e.office_phone ?? '');
        setFaxNumber(e.fax_number ?? '');
        setMobilePhone(e.mobile_phone ?? '');
        setStreetAddress(e.street_address ?? '');
        setCity(e.city ?? '');
        setStateProvince(e.state_province ?? '');
        setPostalCode(e.postal_code ?? '');
        setCountry(e.country ?? '');
      } else if (employee.m365_user_id || employee.google_user_id) {
        const ext = employee.m365_user_id ?? employee.google_user_id;
        const { data } = await supabase
          .from('directory_users')
          .select('office_location, office_phone, fax_number, mobile_phone, street_address, city, state_province, postal_code, country')
          .eq('external_id', ext!)
          .maybeSingle();
        if (cancelled || !data) { setContactLoaded(true); return; }
        const e = data as Record<string, string | null>;
        setOfficeLocation(e.office_location ?? '');
        setOfficePhone(e.office_phone ?? '');
        setFaxNumber(e.fax_number ?? '');
        setMobilePhone(e.mobile_phone ?? '');
        setStreetAddress(e.street_address ?? '');
        setCity(e.city ?? '');
        setStateProvince(e.state_province ?? '');
        setPostalCode(e.postal_code ?? '');
        setCountry(e.country ?? '');
      }
      if (!cancelled) setContactLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [employee.employee_id, employee.m365_user_id, employee.google_user_id]);

  // Manager candidates: anyone in the org except self and offboarded users.
  // Directory-only users get an employees row auto-created on save.
  const managerCandidates = useMemo(() => {
    return allEmployees.filter((e) =>
      e.row_id !== employee.row_id &&
      e.status !== 'offboarded',
    );
  }, [allEmployees, employee.row_id]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const target = employee.employee_id
        ? { employee_id: employee.employee_id }
        : { provider: employee.provider, external_id: employee.m365_user_id ?? employee.google_user_id };
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/employee-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...target,
          patch: {
            full_name: fullName.trim() || null,
            designation: designation.trim() || null,
            department_id: departmentId || null,
            // Backend resolves 'emp:<uuid>' / 'dir:<uuid>' → real employees.id,
            // creating a stub for directory-only users on the fly.
            manager_row_id: managerRowId || '',
            doj: doj || null,
            personal_email: personalEmail.trim() || null,
            status,
            // Contact info — pushed to Graph automatically by employee-save
            // for users linked to an M365 account.
            office_location: officeLocation.trim() || null,
            office_phone:    officePhone.trim() || null,
            fax_number:      faxNumber.trim() || null,
            mobile_phone:    mobilePhone.trim() || null,
            street_address:  streetAddress.trim() || null,
            city:            city.trim() || null,
            state_province:  stateProvince.trim() || null,
            postal_code:     postalCode.trim() || null,
            country:         country.trim() || null,
          },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      // Surface any non-fatal M365 sync issues from the edge function so
      // the customer knows whether changes mirrored to Microsoft 365.
      const m365 = j?.m365 as { ok?: boolean; warnings?: string[] } | undefined;
      if (m365 && m365.ok === false && Array.isArray(m365.warnings) && m365.warnings.length > 0) {
        setErr(`Saved locally, but Microsoft 365 sync had issues:\n• ${m365.warnings.join('\n• ')}`);
        await onSaved();
        return;  // keep modal open so the user can see + retry
      }
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const inputCls = "w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg text-white font-semibold truncate">Edit {employee.display_name}</h2>
            <p className="text-xs text-gray-500 truncate">{employee.work_email ?? '—'}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>

        <div className="p-5 space-y-3 overflow-y-auto">
          {employee.m365_user_id && (
            <div className="px-3 py-2 rounded-lg text-[11px] text-sky-200 bg-sky-500/10 border border-sky-500/30 flex items-start gap-2">
              <i className="ri-microsoft-fill text-base mt-0.5" />
              <span>Changes to contact info + manager will be mirrored to this user's Microsoft 365 profile.</span>
            </div>
          )}
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Full name</span>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputCls} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-gray-400 mb-1">Designation</span>
              <input value={designation} onChange={(e) => setDesignation(e.target.value)} className={inputCls} placeholder="Software Engineer" />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-400 mb-1">Department</span>
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={inputCls}>
                <option value="">— none —</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">
              Manager (reports to)
              {employee.m365_user_id && (
                <span className="ml-2 text-[10px] text-sky-300 font-normal">· syncs to Microsoft 365</span>
              )}
            </span>
            <select value={managerRowId} onChange={(e) => setManagerRowId(e.target.value)} className={inputCls}>
              <option value="">— no manager —</option>
              {managerCandidates.map((m) => (
                <option key={m.row_id} value={m.row_id}>
                  {m.display_name}{m.work_email ? ` · ${m.work_email}` : ''}{!m.has_we_record ? ' (synced)' : ''}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-gray-500 mt-1">
              Any directory user can be picked. We'll auto-create their Rudrans record on save.
              {employee.m365_user_id && <span className="text-sky-300"> Manager will also be set on this user in Microsoft 365.</span>}
            </p>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs text-gray-400 mb-1">Date of joining</span>
              <input type="date" value={doj} onChange={(e) => setDoj(e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-400 mb-1">Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                <option value="active">Active</option>
                <option value="offboarding">Offboarding</option>
                <option value="offboarded">Offboarded</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Personal email (welcome / fallback mail)</span>
            <input type="email" value={personalEmail} onChange={(e) => setPersonalEmail(e.target.value)} className={inputCls} placeholder="firstname@gmail.com" />
          </label>

          {/* ──── Contact information (M365 "Manage contact information" parity) ──── */}
          <div className="pt-2 mt-2 border-t border-dark-700">
            <p className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-2">
              Contact information {!contactLoaded && <span className="text-gray-600 normal-case font-normal ml-1">· loading…</span>}
            </p>

            <label className="block mb-3">
              <span className="block text-xs text-gray-400 mb-1">Office</span>
              <input value={officeLocation} onChange={(e) => setOfficeLocation(e.target.value)} className={inputCls} />
            </label>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">Office phone</span>
                <input value={officePhone} onChange={(e) => setOfficePhone(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">Fax number</span>
                <input value={faxNumber} onChange={(e) => setFaxNumber(e.target.value)} className={inputCls} />
              </label>
            </div>

            <label className="block mb-3">
              <span className="block text-xs text-gray-400 mb-1">Mobile phone</span>
              <input value={mobilePhone} onChange={(e) => setMobilePhone(e.target.value)} className={inputCls} />
            </label>

            <label className="block mb-3">
              <span className="block text-xs text-gray-400 mb-1">Street address</span>
              <input value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} className={inputCls} />
            </label>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">City</span>
                <input value={city} onChange={(e) => setCity(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">State or province</span>
                <input value={stateProvince} onChange={(e) => setStateProvince(e.target.value)} className={inputCls} />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">Zip or postal code</span>
                <input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">Country or region</span>
                <input value={country} onChange={(e) => setCountry(e.target.value)} className={inputCls} />
              </label>
            </div>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2 flex-shrink-0">
          <button disabled={busy} onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
          <button disabled={busy} onClick={save} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
