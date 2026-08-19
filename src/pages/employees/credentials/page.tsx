import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';
import { useAppAccess } from '@/lib/useAppAccess';
import { useAuth } from '@/context/AuthContext';
import { confirmDialog, notify } from '@/lib/notify';

type Credential = {
  id: string;
  org_id: string;
  platform_name: string;
  category: string | null;
  login_url: string | null;
  username: string | null;
  notes: string | null;
  owner_dept_id: string | null;
  tags: string[];
  is_shared_account: boolean;
  active: boolean;
  billing_cycle: 'monthly' | 'quarterly' | 'yearly' | 'one_time' | 'custom' | null;
  price_amount: number | null;
  price_currency: string | null;
  seats_total: number | null;
  // Optional. For usage-based subs (api_usage / hybrid) where the
  // contracted price_amount is just a unit cost — this captures the
  // operator's EXPECTED monthly spend so reports show "budgeted vs
  // billed" instead of one ambiguous number. NULL = no estimate.
  estimated_amount: number | null;
  subscription_starts_at: string | null;
  subscription_ends_at: string | null;
  subscription_model: 'per_seat' | 'api_usage' | 'flat' | 'hybrid' | null;
  billing_api_provider: string | null;
  billing_api_connected: boolean;
  billing_api_last_synced_at: string | null;
  billing_api_last_sync_error: string | null;
  // Auto-invoice fetch: when true, the daily cron enqueues a job to
  // pull this credential's latest invoice via API → email → scrape and
  // forward it to the org's accounts_recipient_emails. Default true.
  auto_fetch_enabled: boolean;
  last_fetch_attempt_at: string | null;
  // OTP / 2FA metadata. Booleans only — never the raw ciphertext.
  has_totp: boolean;
  has_session: boolean;
  otp_primary_channel: 'totp' | 'magic_link' | 'dashboard' | 'email_relay' | 'teams' | 'slack' | 'google_chat' | 'whatsapp' | 'sms_manual';
  otp_fallback_channels: string[];
  otp_admin_user_ids: string[];
  created_at: string;
  last_rotated_at: string | null;
};
type Department = { id: string; name: string };
type Employee = {
  // From v_org_users — covers both Rudrans-created and directory-synced users.
  row_id: string;
  display_name: string;
  work_email: string | null;
  employee_id: string | null;
  provider: 'm365' | 'google' | null;
  m365_user_id: string | null;
  google_user_id: string | null;
  has_we_record: boolean;
};

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'];

const empty: Partial<Credential> & { password?: string } = {
  platform_name: '', category: '', login_url: '', username: '', notes: '',
  owner_dept_id: null, tags: [], is_shared_account: true, active: true,
  billing_cycle: null, price_amount: null, price_currency: 'INR',
  seats_total: null, estimated_amount: null,
  subscription_starts_at: null, subscription_ends_at: null,
  subscription_model: 'per_seat', billing_api_provider: null,
  auto_fetch_enabled: true,
  otp_primary_channel: 'magic_link',
  otp_fallback_channels: ['dashboard', 'magic_link'],
  otp_admin_user_ids: [],
  password: '',
};

export default function CredentialsVault() {
  // Per-feature level for 'credentials'. RequireAccess has already
  // gated the route by the time we render — so the user has AT LEAST
  // 'view'. We hide Add/Edit/Upload buttons at < 'edit', and Delete at
  // < 'full'. Owners + admins always come back as 'full'.
  const { canEdit, canDelete } = useAppAccess();
  const canWrite = canEdit('credentials');
  const canHardDelete = canDelete('credentials');
  const [rows, setRows] = useState<Credential[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  // Per-column filters layered on top of the global search `q`. Each filter
  // narrows the visible rows independently, AND-combined with the others.
  // Empty string / 'all' means "no filter on this column".
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterDept, setFilterDept]         = useState<string>('');   // '' all, 'orgwide' no-dept, else dept_id
  const [filterBilling, setFilterBilling]   = useState<string>('');
  const [filterCurrency, setFilterCurrency] = useState<string>('');
  const [filterActive, setFilterActive]     = useState<'all' | 'active' | 'inactive'>('all');
  const [editing, setEditing] = useState<(Partial<Credential> & { password?: string }) | null>(null);
  const [assignFor, setAssignFor] = useState<Credential[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [csvOpen, setCsvOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [tab, setTab] = useState<'vault' | 'dashboard' | 'invoices' | 'fetch_status' | 'access' | 'requests'>('vault');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    const [c, d, e] = await Promise.all([
      supabase.from('credentials_safe').select('*').order('platform_name').range(0, 9999),
      supabase.from('org_departments').select('id, name').order('name'),
      // Show ALL org users — Rudrans-created + directory-synced — so admins
      // can send creds to anyone in the tenant, not just employees provisioned
      // through the wizard. The send-direct fn auto-creates a Rudrans row for
      // directory-only users at send-time so the assignment can be recorded.
      supabase.from('v_org_users')
        .select('row_id, display_name, work_email, employee_id, provider, m365_user_id, google_user_id, has_we_record')
        .neq('status', 'offboarded')
        .order('display_name'),
    ]);
    setRows((c.data ?? []) as Credential[]);
    setDepts((d.data ?? []) as Department[]);
    setEmployees((e.data ?? []) as Employee[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const deptName = useMemo(() => {
    const m = new Map(depts.map((d) => [d.id, d.name]));
    return (id: string | null) => (id ? m.get(id) ?? '—' : 'org-wide');
  }, [depts]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (ql && ![r.platform_name, r.category, r.username, ...(r.tags ?? [])]
            .filter(Boolean).join(' ').toLowerCase().includes(ql)) return false;
      if (filterCategory && (r.category ?? '') !== filterCategory) return false;
      if (filterDept === 'orgwide') { if (r.owner_dept_id) return false; }
      else if (filterDept && r.owner_dept_id !== filterDept) return false;
      if (filterBilling && (r.billing_cycle ?? '') !== filterBilling) return false;
      if (filterCurrency && (r.price_currency ?? '') !== filterCurrency) return false;
      if (filterActive === 'active'   && !r.active) return false;
      if (filterActive === 'inactive' &&  r.active) return false;
      return true;
    });
  }, [rows, q, filterCategory, filterDept, filterBilling, filterCurrency, filterActive]);

  // Distinct values for the column-filter dropdowns. Recomputed only when
  // `rows` changes; the dropdowns themselves dont rerender otherwise.
  const distinctCategories = useMemo(
    () => [...new Set(rows.map((r) => r.category).filter(Boolean) as string[])].sort(),
    [rows],
  );
  const distinctBilling = useMemo(
    () => [...new Set(rows.map((r) => r.billing_cycle).filter(Boolean) as string[])].sort(),
    [rows],
  );
  const distinctCurrencies = useMemo(
    () => [...new Set(rows.map((r) => r.price_currency).filter(Boolean) as string[])].sort(),
    [rows],
  );

  const anyFilterActive = !!(filterCategory || filterDept || filterBilling || filterCurrency || filterActive !== 'all');
  const clearFilters = () => {
    setFilterCategory(''); setFilterDept(''); setFilterBilling(''); setFilterCurrency(''); setFilterActive('all');
  };

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage],
  );
  // Reset to page 1 on any narrowing change so the user doesn't end up
  // stranded on an empty page after applying a filter.
  useEffect(() => { setPage(1); }, [q, tab, filterCategory, filterDept, filterBilling, filterCurrency, filterActive]);

  const toggleSelect = (id: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Delete a vault credential. Goes through cred-delete edge fn so the
  // org-scope + admin/owner role check happens server-side and an audit
  // row gets written. Two-step confirm because deletion is permanent
  // (FK cascades nuke assignments + invoices + open requests too).
  const deleteCredential = async (r: Credential) => {
    if (!await confirmDialog({ title: `Delete "${r.platform_name}"? This removes the encrypted secret, all assignments, invoices and pending requests. Cannot be undone.`, tone: 'danger' })) return;
    setDeletingId(r.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cred-delete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: r.id }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j?.error ?? `${resp.status}`);
      setRows((rs) => rs.filter((x) => x.id !== r.id));
      setSelected((s) => { const n = new Set(s); n.delete(r.id); return n; });
    } catch (e) {
      notify.error('Delete failed', { description: String((e as Error).message) });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
          <div>
            <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">Credentials Vault</h1>
            <p className="text-sm text-gray-400">Encrypted at rest. Decrypted only inside an Edge Function at send-time.</p>
          </div>
          <div className="flex gap-2">
            <Link to="/employees" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white">Back to employees</Link>
            <Link to="/employees/auto-invoice" className="px-3 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-lg text-xs text-emerald-300" title="One page for fetcher health + activity + coverage">
              <i className="ri-dashboard-3-line mr-1" /> Auto-invoice center
            </Link>
            <Link to="/employees/otp-settings" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white" title="Configure Teams / Slack / Google Chat / WhatsApp for OTP delivery">
              <i className="ri-settings-3-line mr-1" /> OTP channels
            </Link>
            {canWrite && (
              <button
                disabled={selected.size === 0}
                onClick={() => setAssignFor(rows.filter((r) => selected.has(r.id)))}
                className="px-3 py-2 bg-dark-700 hover:bg-dark-600 disabled:opacity-50 rounded-lg text-xs text-white"
              >Send selected ({selected.size}) to user</button>
            )}
            <button
              onClick={() => void exportCredentialsCsv(filtered, depts)}
              disabled={filtered.length === 0}
              className="px-3 py-2 bg-dark-700 hover:bg-dark-600 disabled:opacity-50 rounded-lg text-sm text-white"
              title="Includes platform + billing + assigned users for each credential"
            >
              <i className="ri-file-download-line mr-1" /> Export CSV
            </button>
            {canWrite && (
              <button onClick={() => setCsvOpen(true)} className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">
                <i className="ri-file-upload-line mr-1" /> Upload CSV
              </button>
            )}
            {canWrite && (
              <button onClick={() => setEditing({ ...empty })} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">
                <i className="ri-add-line mr-1" /> New credential
              </button>
            )}
          </div>
        </header>

        <div className="mb-4 flex gap-1 border-b border-dark-700">
          {(['vault', 'dashboard', 'invoices', 'fetch_status', 'access', 'requests'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t ? 'border-emerald-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}>
              {t === 'vault' ? 'Vault'
                : t === 'dashboard' ? 'Dashboard'
                : t === 'invoices' ? 'Invoices'
                : t === 'fetch_status' ? 'Fetch status'
                : t === 'access' ? 'Who has access'
                : 'Requests'}
            </button>
          ))}
        </div>

        {tab === 'requests' ? (
          <RequestsTab />
        ) : tab === 'access' ? (
          <AccessMap />
        ) : tab === 'invoices' ? (
          <InvoicesTab credentials={rows} depts={depts} />
        ) : tab === 'fetch_status' ? (
          <FetchStatusTab credentials={rows} />
        ) : tab === 'dashboard' ? (
          <div className="space-y-4">
            <CostSummary rows={rows} />
            <DepartmentBreakdown rows={rows} depts={depts} />
          </div>
        ) : (
        <>
        <div className="bg-dark-800 border border-dark-700 rounded-xl">
          <div className="p-4 flex flex-col gap-3 border-b border-dark-700">
            <div className="flex-1 flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 transition-colors focus-within:border-emerald-500/50">
              <i className="ri-search-line text-gray-500 text-sm mr-2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search platform, tag, username…"
                className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none flex-1" />
            </div>
            {/* Per-column filters. Each dropdown shows the distinct values currently
                in the vault, so an admin never picks a category that no row has. */}
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mr-1">Filters</span>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="bg-dark-900 border border-dark-700 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500"
                title="Filter by category"
              >
                <option value="">Category · all</option>
                {distinctCategories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={filterDept}
                onChange={(e) => setFilterDept(e.target.value)}
                className="bg-dark-900 border border-dark-700 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500"
                title="Filter by department"
              >
                <option value="">Department · all</option>
                <option value="orgwide">Org-wide (no dept)</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <select
                value={filterBilling}
                onChange={(e) => setFilterBilling(e.target.value)}
                className="bg-dark-900 border border-dark-700 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500"
                title="Filter by billing cycle"
              >
                <option value="">Billing · all</option>
                {distinctBilling.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <select
                value={filterCurrency}
                onChange={(e) => setFilterCurrency(e.target.value)}
                className="bg-dark-900 border border-dark-700 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500"
                title="Filter by currency"
              >
                <option value="">Currency · all</option>
                {distinctCurrencies.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={filterActive}
                onChange={(e) => setFilterActive(e.target.value as 'all' | 'active' | 'inactive')}
                className="bg-dark-900 border border-dark-700 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500"
                title="Filter by status"
              >
                <option value="all">Status · all</option>
                <option value="active">Active only</option>
                <option value="inactive">Inactive only</option>
              </select>
              {anyFilterActive && (
                <button
                  onClick={clearFilters}
                  className="ml-auto text-[11px] text-gray-400 hover:text-rose-300 px-2 py-1 rounded border border-dark-700 hover:border-rose-500/40"
                  title="Reset all column filters"
                >
                  <i className="ri-close-circle-line mr-1" />Clear filters
                </button>
              )}
              <span className={`text-[11px] text-gray-500 ${anyFilterActive ? '' : 'ml-auto'}`}>
                {filtered.length} of {rows.length}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase tracking-wider">
                <tr className="border-b border-dark-700">
                  <th className="px-3 py-3 w-8" />
                  <th className="px-4 py-3 text-left font-medium">Platform</th>
                  <th className="px-4 py-3 text-left font-medium">Category</th>
                  <th className="px-4 py-3 text-left font-medium">Username</th>
                  <th className="px-4 py-3 text-left font-medium">Department</th>
                  <th className="px-4 py-3 text-left font-medium">Billing</th>
                  <th className="px-4 py-3 text-right font-medium">Price</th>
                  <th className="px-4 py-3 text-left font-medium">Active</th>
                  <th className="px-4 py-3 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={9} className="px-4 py-10 text-center text-sm text-gray-500">Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-10 text-center text-sm text-gray-500">No credentials yet.</td></tr>
                ) : pageRows.map((r) => (
                  <tr key={r.id} className="border-b border-dark-700/50 hover:bg-dark-700/30">
                    <td className="px-3 py-3 text-center">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} />
                    </td>
                    <td className="px-4 py-3 text-white">{r.platform_name}</td>
                    <td className="px-4 py-3 text-gray-300">{r.category ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-300 font-mono text-xs">{r.username ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-300">{deptName(r.owner_dept_id)}</td>
                    <td className="px-4 py-3 text-gray-300">{r.billing_cycle ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-300 text-right">
                      {r.price_amount != null
                        ? `${r.price_currency ?? ''} ${r.price_amount.toLocaleString()}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {r.active
                        ? <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">active</span>
                        : <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/15 text-gray-400">inactive</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-3">
                        {r.billing_api_provider && (
                          <ConnectorActions cred={r} onChanged={load} />
                        )}
                        {canWrite && r.auto_fetch_enabled && r.subscription_starts_at && (
                          <TestFetchButton credId={r.id} />
                        )}
                        {canWrite && (
                          <button
                            onClick={() => setEditing({ ...r, password: '' })}
                            className="text-xs text-emerald-400 hover:text-emerald-300"
                          >Edit →</button>
                        )}
                        {canHardDelete && (
                          <button
                            onClick={() => void deleteCredential(r)}
                            disabled={deletingId === r.id}
                            title={`Delete ${r.platform_name}`}
                            className="text-xs text-rose-400 hover:text-rose-300 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {deletingId === r.id ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                        {!canWrite && !canHardDelete && (
                          <span className="text-[11px] text-gray-600">View only</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && filtered.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-dark-700 text-xs text-gray-400">
              <div>
                Showing {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="px-2 py-1 bg-dark-700 hover:bg-dark-600 disabled:opacity-40 rounded text-white"
                >Prev</button>
                <span>Page {safePage} / {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="px-2 py-1 bg-dark-700 hover:bg-dark-600 disabled:opacity-40 rounded text-white"
                >Next</button>
              </div>
            </div>
          )}
        </div>
        </>
        )}
      </div>

      {csvOpen && (
        <CsvImportModal
          onClose={() => setCsvOpen(false)}
          onDone={async () => { setCsvOpen(false); await load(); }}
        />
      )}
      {editing && (
        <CredentialModal
          row={editing} depts={depts}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
      {assignFor && (
        <AssignModal
          creds={assignFor} employees={employees}
          onClose={() => setAssignFor(null)}
          onDone={async () => { setAssignFor(null); setSelected(new Set()); await load(); }}
        />
      )}
    </DashboardLayout>
  );
}

// ============== editor modal ==============

function CredentialModal({
  row, depts, onClose, onSaved,
}: {
  row: Partial<Credential> & { password?: string };
  depts: Department[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [f, setF] = useState(row);
  const [busy, setBusy] = useState(false);

  // Per-seat assignment picker — populated lazily when subscription_model
  // flips to per_seat. Stores employee uuids the customer wants to mark as
  // seat holders. On Save, we ship these to cred-save which inserts
  // credential_assignments rows (no email triggered).
  type EmpOpt = { id: string; full_name: string; work_email: string | null; designation: string | null };
  const [employees, setEmployees] = useState<EmpOpt[]>([]);
  const [empsLoaded, setEmpsLoaded] = useState(false);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [empFilter, setEmpFilter] = useState('');

  // Lazy-load the org's employees the first time per_seat is selected so the
  // modal stays fast for non-per-seat creds.
  useEffect(() => {
    if (f.subscription_model !== 'per_seat' || empsLoaded) return;
    (async () => {
      const { data } = await supabase
        .from('employees')
        .select('id, full_name, work_email, designation, status')
        .eq('status', 'active')
        .order('full_name')
        .range(0, 999);
      setEmployees(((data ?? []) as Array<EmpOpt & { status: string }>).map((e) => ({
        id: e.id, full_name: e.full_name, work_email: e.work_email, designation: e.designation,
      })));
      setEmpsLoaded(true);
    })();
  }, [f.subscription_model, empsLoaded]);
  const [err, setErr] = useState<string | null>(null);
  const isNew = !row.id;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cred-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: f.id, platform_name: f.platform_name, category: f.category || null,
          login_url: f.login_url || null, username: f.username || null, password: f.password || undefined,
          notes: f.notes || null, owner_dept_id: f.owner_dept_id || null,
          tags: typeof (f.tags as unknown) === 'string' ? (f.tags as unknown as string).split(',').map((s) => s.trim()).filter(Boolean) : (f.tags ?? []),
          is_shared_account: f.is_shared_account ?? true,
          active: f.active ?? true,
          billing_cycle: f.billing_cycle ?? null,
          price_amount: f.price_amount,
          price_currency: f.price_currency ?? null,
          seats_total: f.seats_total,
          estimated_amount: f.estimated_amount,
          subscription_starts_at: f.subscription_starts_at ?? null,
          subscription_ends_at: f.subscription_ends_at ?? null,
          subscription_model: f.subscription_model ?? null,
          billing_api_provider: f.billing_api_provider ?? null,
          auto_fetch_enabled: f.auto_fetch_enabled ?? true,
          totp_secret: (f as Partial<Credential> & { totp_secret?: string }).totp_secret || undefined,
          otp_primary_channel: f.otp_primary_channel ?? null,
          otp_fallback_channels: f.otp_fallback_channels ?? null,
          assigned_employee_ids: f.subscription_model === 'per_seat' ? Array.from(assignedIds) : [],
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg text-white font-semibold">{isNew ? 'New credential' : 'Edit credential'}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>
        <div className="p-5 space-y-3 overflow-y-auto">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}
          <Field label="Platform name *">
            <input value={f.platform_name ?? ''} onChange={(e) => setF({ ...f, platform_name: e.target.value })} className={inputCls} placeholder="Figma" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <input value={f.category ?? ''} onChange={(e) => setF({ ...f, category: e.target.value })} className={inputCls} placeholder="design" />
            </Field>
            <Field label="Department scope">
              <select value={f.owner_dept_id ?? ''} onChange={(e) => setF({ ...f, owner_dept_id: e.target.value || null })} className={inputCls}>
                <option value="">— Org-wide —</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Login URL">
            <input value={f.login_url ?? ''} onChange={(e) => setF({ ...f, login_url: e.target.value })} className={inputCls} placeholder="https://app.figma.com" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username">
              <input value={f.username ?? ''} onChange={(e) => setF({ ...f, username: e.target.value })} className={inputCls} placeholder="design@acme.com" />
            </Field>
            <Field label={isNew ? 'Password (optional)' : 'Password (leave blank to keep)'}>
              <input type="password" value={f.password ?? ''} onChange={(e) => setF({ ...f, password: e.target.value })} className={inputCls} placeholder="leave blank for OTP / SSO" />
            </Field>
          </div>
          <Field label="Tags (comma-separated)">
            <input value={Array.isArray(f.tags) ? f.tags.join(', ') : (f.tags ?? '')} onChange={(e) => setF({ ...f, tags: e.target.value as unknown as string[] })} className={inputCls} placeholder="design, sso" />
          </Field>
          <Field label="Notes">
            <textarea value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} className={`${inputCls} h-20 resize-none`} placeholder="Use SSO if possible" />
          </Field>

          <div className="pt-3 mt-2 border-t border-dark-700">
            <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Subscription / billing</p>
            <div className="grid grid-cols-2 gap-3 mb-2">
              <Field label="Subscription model">
                <select value={f.subscription_model ?? ''} onChange={(e) => setF({ ...f, subscription_model: (e.target.value || null) as Credential['subscription_model'] })} className={inputCls}>
                  <option value="">—</option>
                  <option value="per_seat">Per-seat (user-based)</option>
                  <option value="api_usage">API / usage-based (e.g. OpenAI, Anthropic)</option>
                  <option value="flat">Flat (single fee, no seats)</option>
                  <option value="hybrid">Hybrid (seats + usage)</option>
                </select>
              </Field>
              <Field label="Billing API provider (optional)">
                <select value={f.billing_api_provider ?? ''} onChange={(e) => setF({ ...f, billing_api_provider: e.target.value || null })} className={inputCls}>
                  <option value="">— manual / CSV only —</option>
                  <option value="stripe">Stripe</option>
                  <option value="razorpay">Razorpay</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="aws">AWS</option>
                  <option value="other">Other</option>
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <Field label="Billing cycle">
                <select value={f.billing_cycle ?? ''} onChange={(e) => setF({ ...f, billing_cycle: (e.target.value || null) as Credential['billing_cycle'] })} className={inputCls}>
                  <option value="">—</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                  <option value="one_time">One-time</option>
                  <option value="custom">Custom</option>
                </select>
              </Field>
              <Field label="Price">
                <input type="number" step="0.01" value={f.price_amount ?? ''} onChange={(e) => setF({ ...f, price_amount: e.target.value === '' ? null : Number(e.target.value) })} className={inputCls} placeholder="0.00" />
              </Field>
              <Field label="Currency">
                <select value={f.price_currency ?? 'INR'} onChange={(e) => setF({ ...f, price_currency: e.target.value })} className={inputCls}>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
              <Field label="Total seats (optional)">
                <input type="number" value={f.seats_total ?? ''} onChange={(e) => setF({ ...f, seats_total: e.target.value === '' ? null : Number(e.target.value) })} className={inputCls} placeholder="10" />
              </Field>
              <Field label="Estimated amount (optional)">
                <input
                  type="number"
                  step="0.01"
                  value={f.estimated_amount ?? ''}
                  onChange={(e) => setF({ ...f, estimated_amount: e.target.value === '' ? null : Number(e.target.value) })}
                  className={inputCls}
                  placeholder="0.00"
                />
              </Field>
              <Field label="Starts on">
                <input type="date" value={f.subscription_starts_at ?? ''} onChange={(e) => setF({ ...f, subscription_starts_at: e.target.value || null })} className={inputCls} />
              </Field>
              <Field label="Ends / renews on">
                <input type="date" value={f.subscription_ends_at ?? ''} onChange={(e) => setF({ ...f, subscription_ends_at: e.target.value || null })} className={inputCls} />
              </Field>
            </div>

            {/* Auto-invoice fetch toggle. When on, the daily cron pulls the
                latest invoice (via API → email → scrape) and forwards it
                to the org's accounts_recipient_emails. Requires a billing
                start date for the cron to know which period to fetch. */}
            <label className="flex items-start gap-3 mt-3 p-3 rounded-lg bg-dark-900/40 border border-dark-700 cursor-pointer">
              <input
                type="checkbox"
                checked={f.auto_fetch_enabled ?? true}
                onChange={(e) => setF({ ...f, auto_fetch_enabled: e.target.checked })}
                className="mt-0.5"
              />
              <div className="flex-1">
                <p className="text-xs text-white font-medium">Auto-fetch monthly invoice</p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Every billing cycle, Rudrans pulls the latest invoice from this platform and emails it to your accounts team.
                  {!f.subscription_starts_at && (
                    <span className="block text-amber-400/80 mt-1">Set a "Starts on" date above to anchor the billing period.</span>
                  )}
                </p>
              </div>
            </label>

            {/* MFA / OTP delivery — only when auto-fetch is on. */}
            {(f.auto_fetch_enabled ?? true) && (
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="TOTP secret (Authenticator app)">
                  <input
                    type="password"
                    value={(f as Partial<Credential> & { totp_secret?: string }).totp_secret ?? ''}
                    onChange={(e) => setF({ ...f, totp_secret: e.target.value } as typeof f)}
                    className={inputCls}
                    placeholder={(f as Credential).has_totp ? '••••••••  (leave blank to keep)' : 'JBSWY3DPEHPK3PXP'}
                  />
                </Field>
                <Field label="When OTP needed, send to…">
                  <select
                    value={f.otp_primary_channel ?? 'magic_link'}
                    onChange={(e) => setF({ ...f, otp_primary_channel: e.target.value as Credential['otp_primary_channel'] })}
                    className={inputCls}
                  >
                    <option value="totp">Generate from TOTP secret (instant)</option>
                    <option value="magic_link">Email magic link to OTP admins</option>
                    <option value="dashboard">In-dashboard banner (realtime)</option>
                    <option value="email_relay">Email-relay only</option>
                    <option value="teams" disabled>Microsoft Teams (Phase 3)</option>
                    <option value="slack" disabled>Slack (Phase 3)</option>
                    <option value="google_chat" disabled>Google Chat (Phase 3)</option>
                    <option value="whatsapp" disabled>WhatsApp (Phase 3)</option>
                  </select>
                </Field>
              </div>
            )}
          </div>

          {/* Per-seat assignment picker — only when subscription_model = per_seat. */}
          {f.subscription_model === 'per_seat' && (
            <div className="pt-3 mt-2 border-t border-dark-700">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-xs uppercase tracking-wider text-gray-500">Assigned employees</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Mark which employees take up a seat for this credential.
                    Selecting them <strong>does not</strong> auto-send the password — use "Send to user" later to dispatch.
                  </p>
                </div>
                <div className="text-[11px] text-gray-400 shrink-0">
                  <span className="text-cyan-300 font-semibold">{assignedIds.size}</span>
                  {f.seats_total ? <span className="text-gray-500"> / {f.seats_total}</span> : null}
                  <span className="text-gray-500"> selected</span>
                </div>
              </div>

              <input
                value={empFilter}
                onChange={(e) => setEmpFilter(e.target.value)}
                placeholder="Search by name, email, designation…"
                className={`${inputCls} mb-2`}
              />

              <div className="max-h-56 overflow-y-auto bg-dark-900/60 rounded-lg border border-dark-700 divide-y divide-dark-700/50">
                {!empsLoaded ? (
                  <p className="px-3 py-4 text-center text-xs text-gray-500">Loading employees…</p>
                ) : employees.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-gray-500">No active employees yet. Add some under Employees → Add user.</p>
                ) : (() => {
                  const q = empFilter.trim().toLowerCase();
                  const list = q
                    ? employees.filter((e) =>
                        [e.full_name, e.work_email, e.designation].filter(Boolean).join(' ').toLowerCase().includes(q),
                      )
                    : employees;
                  if (list.length === 0) {
                    return <p className="px-3 py-4 text-center text-xs text-gray-500">No matches for "{empFilter}".</p>;
                  }
                  return list.map((e) => {
                    const checked = assignedIds.has(e.id);
                    return (
                      <label key={e.id} className="flex items-center gap-3 px-3 py-2 hover:bg-dark-800/40 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={async () => {
                            if (checked) {
                              setAssignedIds((prev) => {
                                const next = new Set(prev);
                                next.delete(e.id);
                                return next;
                              });
                              return;
                            }
                            // Soft cap on seats — warn but don't hard-block (the
                            // customer may be mid-resize). The prompt has to
                            // happen out here: a useState updater must stay
                            // synchronous and side-effect free, so it can't await.
                            if (f.seats_total && assignedIds.size >= f.seats_total) {
                              const ok = await confirmDialog({
                                title: `Seat limit of ${f.seats_total} already reached`,
                                body: 'You can still assign this employee — the extra seat will need to be covered when you next save.',
                                confirmLabel: 'Assign anyway',
                              });
                              if (!ok) return;
                            }
                            setAssignedIds((prev) => {
                              const next = new Set(prev);
                              next.add(e.id);
                              return next;
                            });
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-white truncate">{e.full_name}</p>
                          <p className="text-[10px] text-gray-500 truncate">
                            {e.work_email ?? '—'}{e.designation ? ` · ${e.designation}` : ''}
                          </p>
                        </div>
                        {checked && <span className="text-[10px] text-emerald-300 shrink-0">Will assign</span>}
                      </label>
                    );
                  });
                })()}
              </div>

              {empsLoaded && employees.length > 0 && (
                <div className="flex items-center gap-3 mt-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setAssignedIds(new Set(employees.map((e) => e.id)))}
                    className="text-cyan-400 hover:text-cyan-300"
                  >
                    Select all visible
                  </button>
                  <button
                    type="button"
                    onClick={() => setAssignedIds(new Set())}
                    className="text-gray-500 hover:text-gray-300"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input type="checkbox" checked={f.active ?? true} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            Active (can be assigned)
          </label>
        </div>
        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
          <button onClick={save} disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ============== assign modal ==============

function AssignModal({
  creds, employees, onClose, onDone,
}: {
  creds: Credential[];
  employees: Employee[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [rowId, setRowId] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Array<{ credential_id: string; ok: boolean; error?: string }> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!rowId) return;
    const picked = employees.find((e) => e.row_id === rowId);
    if (!picked) return;
    setBusy(true); setErr(null); setOutcomes(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      // If the picked user has a Rudrans employees row, send by employee_id.
      // Otherwise pass the directory identifier so the edge fn can lazily
      // create the Rudrans row before inserting the assignment.
      const target = picked.employee_id
        ? { employee_id: picked.employee_id }
        : { provider: picked.provider, external_id: picked.m365_user_id ?? picked.google_user_id };
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cred-send-direct`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, credential_ids: creds.map((c) => c.id) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setOutcomes(j.sent as Array<{ credential_id: string; ok: boolean; error?: string }>);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
          <h2 className="text-lg text-white font-semibold">Send {creds.length} credential(s)</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>
        <div className="p-5 space-y-3">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

          <ul className="text-xs text-gray-300 max-h-40 overflow-y-auto bg-dark-900/60 rounded-lg p-3">
            {creds.map((c) => <li key={c.id}>• {c.platform_name}</li>)}
          </ul>

          {!outcomes ? (
            <>
              <Field label="Send to user">
                <select value={rowId} onChange={(e) => setRowId(e.target.value)} className={inputCls}>
                  <option value="">— pick user —</option>
                  {employees.map((e) => (
                    <option key={e.row_id} value={e.row_id}>
                      {e.display_name}{e.work_email ? ` · ${e.work_email}` : ''}{!e.has_we_record ? ' (synced)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-xs text-gray-500">Each credential will be emailed in a separate message and recorded in this employee's history.</p>
            </>
          ) : (
            <div className="space-y-1.5">
              {outcomes.map((o) => {
                const c = creds.find((x) => x.id === o.credential_id);
                return (
                  <div key={o.credential_id} className="flex items-center gap-2 text-xs">
                    <i className={o.ok ? 'ri-check-line text-emerald-400' : 'ri-close-line text-rose-400'} />
                    <span className="text-white flex-1">{c?.platform_name}</span>
                    {!o.ok && <span className="text-rose-400 text-xs truncate">{o.error}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">
          {!outcomes ? (
            <>
              <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
              <button onClick={submit} disabled={!rowId || busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
                {busy ? 'Sending…' : 'Send now'}
              </button>
            </>
          ) : (
            <button onClick={onDone} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">Done</button>
          )}
        </footer>
      </div>
    </div>
  );
}

const inputCls = "w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-xs text-gray-400 mb-1">{label}</span>{children}</label>;
}

// ============== Requests tab — incoming credential requests ==============

type RequestRow = {
  id: string;
  org_id: string;
  requester_employee_id: string | null;
  requester_email: string;
  manager_id: string | null;
  requested_credential_ids: string[];
  custom_text: string | null;
  status: 'pending_manager' | 'pending_it' | 'approved' | 'rejected' | 'fulfilled';
  decision_notes: string | null;
  manager_decided_at: string | null;
  it_decided_at: string | null;
  fulfilled_at: string | null;
  it_recipients: string[];
  created_at: string;
};

const STATUS_TINT: Record<RequestRow['status'], { label: string; cls: string }> = {
  pending_manager: { label: 'Pending manager', cls: 'bg-amber-500/15 text-amber-400' },
  pending_it:      { label: 'Pending IT',      cls: 'bg-blue-500/15 text-blue-400' },
  approved:        { label: 'Approved',        cls: 'bg-emerald-500/15 text-emerald-400' },
  rejected:        { label: 'Rejected',        cls: 'bg-rose-500/15 text-rose-400' },
  fulfilled:       { label: 'Fulfilled',       cls: 'bg-emerald-500/15 text-emerald-300' },
};

function RequestsTab() {
  const [reqs, setReqs] = useState<RequestRow[]>([]);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [itRecipients, setItRecipients] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | RequestRow['status']>('all');
  const [detail, setDetail] = useState<RequestRow | null>(null);
  const [copied, setCopied] = useState(false);
  const [recipientsOpen, setRecipientsOpen] = useState(false);

  // Public form URL — what employees use. We construct it from the current
  // origin so it works in dev (localhost) and prod automatically.
  const publicFormUrl = `${window.location.origin}/r/credentials-request`;
  // Pin the org lookup to the user's actual org — super-admins see ALL
  // orgs through RLS, so `.limit(1)` would otherwise return some other
  // tenant's it_recipient_emails. See feedback-super-admin-rls-limit-pitfall.
  const { organization } = useAuth();
  const orgId = organization?.id ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    const [r, c, o] = await Promise.all([
      supabase.from('credential_requests').select('*').order('created_at', { ascending: false }),
      supabase.from('credentials_safe').select('id, platform_name'),
      orgId
        ? supabase.from('organizations').select('it_recipient_emails').eq('id', orgId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    setReqs((r.data ?? []) as RequestRow[]);
    setCreds((c.data ?? []) as Credential[]);
    setItRecipients(((o.data?.it_recipient_emails ?? []) as string[]));
    setLoading(false);
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const platformName = useMemo(() => {
    const m = new Map(creds.map((c) => [c.id, c.platform_name]));
    return (id: string) => m.get(id) ?? id;
  }, [creds]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return reqs.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!ql) return true;
      return [r.requester_email, r.custom_text, ...r.requested_credential_ids.map(platformName)]
        .filter(Boolean).join(' ').toLowerCase().includes(ql);
    });
  }, [reqs, q, statusFilter, platformName]);

  const copyLink = async () => {
    await navigator.clipboard.writeText(publicFormUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-4">
      {/* Public form URL — admins share this with employees so they can self-serve. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <i className="ri-link text-emerald-400" />
            <p className="text-xs text-gray-400 uppercase tracking-wider">Public request form</p>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm text-emerald-300 font-mono bg-dark-900 px-3 py-2 rounded-lg truncate">{publicFormUrl}</code>
            <button onClick={copyLink} className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white">
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <a href={publicFormUrl} target="_blank" rel="noreferrer" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white">
              <i className="ri-external-link-line" /> Open
            </a>
          </div>
          <p className="text-[11px] text-gray-500 mt-2">
            Share with employees. Submission is gated by their email domain matching a connected directory integration.
          </p>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <i className="ri-mail-add-line text-blue-400" />
              <p className="text-xs text-gray-400 uppercase tracking-wider">IT recipients (CC on every request)</p>
            </div>
            <button onClick={() => setRecipientsOpen(true)} className="text-xs text-blue-400 hover:text-blue-300">Edit</button>
          </div>
          {itRecipients.length === 0 ? (
            <p className="text-xs text-rose-300">
              ⚠️ None configured. Requests without a manager on file will be rejected until you add at least one IT email.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {itRecipients.map((e) => (
                <span key={e} className="text-xs px-2 py-1 bg-dark-900 border border-dark-700 rounded-lg text-gray-300">{e}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl">
        <div className="p-4 flex flex-col md:flex-row gap-3 md:items-center border-b border-dark-700">
          <div className="flex-1 flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5">
            <i className="ri-search-line text-gray-500 text-sm mr-2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search requester, platform, text…"
              className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none flex-1" />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white">
            <option value="all">All statuses</option>
            <option value="pending_manager">Pending manager</option>
            <option value="pending_it">Pending IT</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 uppercase tracking-wider">
              <tr className="border-b border-dark-700">
                <th className="px-4 py-3 text-left font-medium">Requester</th>
                <th className="px-4 py-3 text-left font-medium">Platforms</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Submitted</th>
                <th className="px-4 py-3 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-500">No requests yet. Share the form URL above with your team.</td></tr>
              ) : filtered.map((r) => {
                const tint = STATUS_TINT[r.status];
                const names = r.requested_credential_ids.map(platformName);
                return (
                  <tr key={r.id} className="border-b border-dark-700/50 hover:bg-dark-700/30">
                    <td className="px-4 py-3 text-white">
                      <p>{r.requester_email}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      <p className="truncate max-w-[280px]">
                        {names.length === 0 ? <span className="text-gray-500">(custom only)</span> : names.slice(0, 3).join(', ')}
                        {names.length > 3 && ` +${names.length - 3}`}
                      </p>
                    </td>
                    <td className="px-4 py-3"><span className={`text-xs px-2 py-1 rounded-full ${tint.cls}`}>{tint.label}</span></td>
                    <td className="px-4 py-3 text-gray-300">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setDetail(r)} className="text-xs text-emerald-400 hover:text-emerald-300">Details →</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <RequestDetailDrawer
          req={detail}
          platformName={platformName}
          onClose={() => setDetail(null)}
        />
      )}

      {recipientsOpen && (
        <ItRecipientsModal
          current={itRecipients}
          onClose={() => setRecipientsOpen(false)}
          onSaved={async () => { setRecipientsOpen(false); await load(); }}
        />
      )}
    </div>
  );
}

function ItRecipientsModal({
  current, onClose, onSaved,
}: {
  current: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [raw, setRaw] = useState(current.join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const emails = raw.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/org-settings-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ it_recipient_emails: emails }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700">
          <h2 className="text-lg text-white font-semibold">IT recipients</h2>
          <p className="text-xs text-gray-500 mt-0.5">CC'd on every credential request. TO once the manager approves.</p>
        </header>
        <div className="p-5 space-y-3">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Emails (comma or newline separated)</span>
            <textarea value={raw} onChange={(e) => setRaw(e.target.value)}
              className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 h-32 resize-none"
              placeholder="it@company.com, infra@company.com" />
          </label>
          <p className="text-[11px] text-gray-500">Only the org owner can change these.</p>
        </div>
        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">
          <button disabled={busy} onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
          <button disabled={busy} onClick={save} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function RequestDetailDrawer({
  req, platformName, onClose,
}: {
  req: RequestRow;
  platformName: (id: string) => string;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<Array<{ id: string; actor: string; actor_email: string | null; event: string; detail: Record<string, unknown>; created_at: string }>>([]);
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('credential_request_events')
        .select('id, actor, actor_email, event, detail, created_at')
        .eq('request_id', req.id)
        .order('created_at', { ascending: true });
      setEvents((data ?? []) as typeof events);
    })();
  }, [req.id]);

  const tint = STATUS_TINT[req.status];
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <aside className="w-full max-w-md bg-dark-800 border-l border-dark-700 overflow-y-auto">
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Credential request</p>
            <h2 className="text-lg text-white font-semibold truncate">{req.requester_email}</h2>
            <span className={`mt-1 inline-block text-xs px-2 py-1 rounded-full ${tint.cls}`}>{tint.label}</span>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>
        <div className="p-5 space-y-5">
          <section>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Submitted</p>
            <p className="text-sm text-white">{new Date(req.created_at).toLocaleString()}</p>
          </section>

          <section>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Platforms requested ({req.requested_credential_ids.length})</p>
            {req.requested_credential_ids.length === 0 ? (
              <p className="text-xs text-gray-500">None from the catalogue</p>
            ) : (
              <ul className="space-y-1">
                {req.requested_credential_ids.map((id) => (
                  <li key={id} className="text-sm text-white px-2.5 py-1.5 bg-dark-900/60 rounded-lg">{platformName(id)}</li>
                ))}
              </ul>
            )}
          </section>

          {req.custom_text && (
            <section>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Free-text request</p>
              <p className="text-sm text-gray-300 bg-dark-900/60 rounded-lg p-3 whitespace-pre-wrap">{req.custom_text}</p>
            </section>
          )}

          {req.it_recipients.length > 0 && (
            <section>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">IT recipients (CC at submit, TO after manager approve)</p>
              <p className="text-xs text-gray-300 break-words">{req.it_recipients.join(', ')}</p>
            </section>
          )}

          <section>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Timeline</p>
            <ol className="space-y-2">
              {events.length === 0 ? (
                <li className="text-xs text-gray-500">No events recorded yet.</li>
              ) : events.map((ev) => (
                <li key={ev.id} className="flex gap-3">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 mt-1.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white">{eventLabel(ev.event)}</p>
                    <p className="text-[11px] text-gray-500">
                      {ev.actor}{ev.actor_email ? ` · ${ev.actor_email}` : ''} · {new Date(ev.created_at).toLocaleString()}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {req.decision_notes && (
            <section>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Decision notes</p>
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{req.decision_notes}</p>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

function eventLabel(ev: string): string {
  return ({
    submitted:         'Submitted by requester',
    manager_approved:  'Manager approved — routed to IT',
    manager_rejected:  'Manager rejected',
    it_approved:       'IT approved — sending creds',
    it_rejected:       'IT rejected',
    fulfilled:         'Credentials delivered',
    mail_sent:         'Email sent',
  } as Record<string, string>)[ev] ?? ev;
}

// ============== Cost summary (monthly + yearly per currency) ==============
//
// We DON'T do FX conversion — different currencies stay separate. Inactive
// credentials and ones missing price/cycle are skipped. One-time + custom
// cycles contribute to a separate "one-time" bucket since they have no
// recurring monthly/yearly equivalent.

function CostSummary({ rows }: { rows: Credential[] }) {
  const totals = useMemo(() => {
    const monthly: Record<string, number> = {};
    const yearly:  Record<string, number> = {};
    const oneTime: Record<string, number> = {};
    // estimated_amount is interpreted as "expected monthly spend" (see
    // schema comment on the column). It exists alongside price_amount
    // for usage-based subs where the contracted unit cost can't predict
    // real spend on its own. We show it in its OWN card so the operator
    // can compare contracted vs estimated without one drowning the other.
    const estMonthly: Record<string, number> = {};
    const estYearly:  Record<string, number> = {};
    let activeWithBilling = 0;
    let activeWithEstimate = 0;
    for (const r of rows) {
      if (!r.active) continue;
      const cur = r.price_currency;
      if (r.price_amount != null && cur) {
        activeWithBilling++;
        const amt = Number(r.price_amount);
        if (r.billing_cycle === 'monthly') {
          monthly[cur] = (monthly[cur] ?? 0) + amt;
          yearly[cur]  = (yearly[cur]  ?? 0) + amt * 12;
        } else if (r.billing_cycle === 'quarterly') {
          monthly[cur] = (monthly[cur] ?? 0) + amt / 3;
          yearly[cur]  = (yearly[cur]  ?? 0) + amt * 4;
        } else if (r.billing_cycle === 'yearly') {
          monthly[cur] = (monthly[cur] ?? 0) + amt / 12;
          yearly[cur]  = (yearly[cur]  ?? 0) + amt;
        } else if (r.billing_cycle === 'one_time' || r.billing_cycle === 'custom') {
          oneTime[cur] = (oneTime[cur] ?? 0) + amt;
        }
      }
      if (r.estimated_amount != null && cur) {
        activeWithEstimate++;
        const amt = Number(r.estimated_amount);
        estMonthly[cur] = (estMonthly[cur] ?? 0) + amt;
        estYearly[cur]  = (estYearly[cur]  ?? 0) + amt * 12;
      }
    }
    return { monthly, yearly, oneTime, estMonthly, estYearly, activeWithBilling, activeWithEstimate };
  }, [rows]);

  const monthlyCurrencies  = Object.keys(totals.monthly).sort();
  const yearlyCurrencies   = Object.keys(totals.yearly).sort();
  const oneTimeCurrencies  = Object.keys(totals.oneTime).sort();
  const estMonthlyCurrs    = Object.keys(totals.estMonthly).sort();
  const estYearlyCurrs     = Object.keys(totals.estYearly).sort();
  const showEstimated = totals.activeWithEstimate > 0;

  if (totals.activeWithBilling === 0 && !showEstimated) return null;

  return (
    <div className={`grid grid-cols-1 gap-3 mb-4 ${showEstimated ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
      <CostCard title="Monthly recurring" icon="ri-calendar-line"   currencies={monthlyCurrencies} amounts={totals.monthly} accent="text-emerald-400" />
      <CostCard title="Yearly recurring"  icon="ri-calendar-2-line" currencies={yearlyCurrencies}  amounts={totals.yearly}  accent="text-cyan-400" />
      <CostCard title="One-time / custom" icon="ri-coin-line"       currencies={oneTimeCurrencies} amounts={totals.oneTime} accent="text-amber-400" />
      {showEstimated && (
        <CostCard
          title="Estimated spend"
          icon="ri-line-chart-line"
          currencies={Array.from(new Set([...estMonthlyCurrs, ...estYearlyCurrs])).sort()}
          amounts={totals.estMonthly}
          amountsSecondary={totals.estYearly}
          secondaryLabel="/yr"
          primaryLabel="/mo"
          accent="text-violet-400"
        />
      )}
    </div>
  );
}

function CostCard({
  title, icon, currencies, amounts, accent,
  amountsSecondary, primaryLabel, secondaryLabel,
}: {
  title: string;
  icon: string;
  currencies: string[];
  amounts: Record<string, number>;
  accent: string;
  amountsSecondary?: Record<string, number>;
  primaryLabel?: string;
  secondaryLabel?: string;
}) {
  const fmt = (n?: number) =>
    n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <i className={`${icon} ${accent}`} />
        <p className="text-xs text-gray-400 uppercase tracking-wider">{title}</p>
      </div>
      {currencies.length === 0 ? (
        <p className="text-sm text-gray-500">—</p>
      ) : (
        <div className="space-y-1">
          {currencies.map((cur) => (
            <div key={cur} className="flex justify-between items-baseline gap-2">
              <span className="text-xs text-gray-500">{cur}</span>
              <div className="flex items-baseline gap-2">
                <span className={`text-lg font-semibold ${accent}`}>{fmt(amounts[cur])}</span>
                {primaryLabel && <span className="text-[10px] text-gray-500">{primaryLabel}</span>}
                {amountsSecondary && (
                  <>
                    <span className="text-xs text-gray-500">·</span>
                    <span className="text-sm text-gray-300">{fmt(amountsSecondary[cur])}</span>
                    {secondaryLabel && <span className="text-[10px] text-gray-500">{secondaryLabel}</span>}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============== Department breakdown (spend by department) ==============
//
// Same accounting rules as CostSummary (yearly/12, quarterly/3, monthly,
// one-time → standalone bucket), grouped by owner_dept_id with a synthetic
// "(org-wide)" bucket for creds with no department set. Currencies stay
// separate — no FX conversion.

function DepartmentBreakdown({ rows, depts }: { rows: Credential[]; depts: Department[] }) {
  // Track which department bucket the admin is inspecting via a modal.
  // null = closed. 'orgwide' = the no-department bucket. Any other value = dept_id.
  const [inspectKey, setInspectKey] = useState<string | null>(null);
  const data = useMemo(() => {
    // key = dept_id (or 'orgwide') → bucket of per-currency totals + the
    // actual rows that fed the totals (used by the click-through modal).
    // `est` mirrors `monthly` but accumulates estimated_amount (the
    // operator's expected monthly spend on usage-based subs). Kept in a
    // separate column so contracted vs estimated stay distinguishable.
    type Bucket = {
      monthly: Record<string, number>;
      yearly: Record<string, number>;
      oneTime: Record<string, number>;
      est: Record<string, number>;
      count: number;
      creds: Credential[];
    };
    const byDept = new Map<string, Bucket>();
    const ensure = (k: string): Bucket => {
      if (!byDept.has(k)) byDept.set(k, { monthly: {}, yearly: {}, oneTime: {}, est: {}, count: 0, creds: [] });
      return byDept.get(k)!;
    };

    for (const r of rows) {
      if (!r.active) continue;
      const cur = r.price_currency;
      if (r.price_amount == null && r.estimated_amount == null) continue;
      if (!cur) continue;
      const key = r.owner_dept_id ?? 'orgwide';
      const bucket = ensure(key);
      bucket.count++;
      bucket.creds.push(r);
      if (r.price_amount != null) {
        const amt = Number(r.price_amount);
        if (r.billing_cycle === 'monthly') {
          bucket.monthly[cur] = (bucket.monthly[cur] ?? 0) + amt;
          bucket.yearly[cur]  = (bucket.yearly[cur]  ?? 0) + amt * 12;
        } else if (r.billing_cycle === 'quarterly') {
          bucket.monthly[cur] = (bucket.monthly[cur] ?? 0) + amt / 3;
          bucket.yearly[cur]  = (bucket.yearly[cur]  ?? 0) + amt * 4;
        } else if (r.billing_cycle === 'yearly') {
          bucket.monthly[cur] = (bucket.monthly[cur] ?? 0) + amt / 12;
          bucket.yearly[cur]  = (bucket.yearly[cur]  ?? 0) + amt;
        } else if (r.billing_cycle === 'one_time' || r.billing_cycle === 'custom') {
          bucket.oneTime[cur] = (bucket.oneTime[cur] ?? 0) + amt;
        }
      }
      if (r.estimated_amount != null) {
        bucket.est[cur] = (bucket.est[cur] ?? 0) + Number(r.estimated_amount);
      }
    }
    return byDept;
  }, [rows]);

  const deptName = useMemo(() => {
    const m = new Map(depts.map((d) => [d.id, d.name]));
    return (id: string) => (id === 'orgwide' ? 'Org-wide' : (m.get(id) ?? id));
  }, [depts]);

  // Sort by largest monthly spend first across currencies (rough USD-ish
  // weighting isn't worth FX complexity — sum all currency-amount pairs
  // and sort. Department with the biggest active subscriptions surfaces
  // at the top, which is what an admin scanning this table wants.)
  const orderedKeys = useMemo(() => {
    const weight = (k: string) =>
      Object.values(data.get(k)?.monthly ?? {}).reduce((a, b) => a + b, 0);
    return [...data.keys()].sort((a, b) => weight(b) - weight(a));
  }, [data]);

  // Column totals (per-currency) for the footer row.
  const totals = useMemo(() => {
    const monthly: Record<string, number> = {};
    const yearly: Record<string, number> = {};
    const oneTime: Record<string, number> = {};
    const est: Record<string, number> = {};
    let count = 0;
    for (const b of data.values()) {
      count += b.count;
      for (const [c, v] of Object.entries(b.monthly)) monthly[c] = (monthly[c] ?? 0) + v;
      for (const [c, v] of Object.entries(b.yearly))  yearly[c]  = (yearly[c]  ?? 0) + v;
      for (const [c, v] of Object.entries(b.oneTime)) oneTime[c] = (oneTime[c] ?? 0) + v;
      for (const [c, v] of Object.entries(b.est))     est[c]     = (est[c]     ?? 0) + v;
    }
    return { monthly, yearly, oneTime, est, count };
  }, [data]);

  // If every department's one-time / estimated bucket is empty, hide the
  // column entirely — keeps the table scannable instead of wallpapering
  // it with em-dashes.
  const showOneTime  = Object.keys(totals.oneTime).length > 0;
  const showEstimated = Object.keys(totals.est).length > 0;

  if (orderedKeys.length === 0) return null;

  // Each cell renders currencies as a vertical stack: "INR  ₹1,599 / CAD  $223.46".
  // Right-aligned, monospaced, currency code as a small badge so the eye
  // tracks down the column.
  const CurrencyCell = ({ obj }: { obj: Record<string, number> }) => {
    const keys = Object.keys(obj).sort();
    if (!keys.length) return <span className="text-gray-600">—</span>;
    return (
      <div className="flex flex-col items-end gap-0.5">
        {keys.map((cur) => (
          <div key={cur} className="flex items-baseline gap-2 tabular-nums">
            <span className="text-[10px] font-semibold text-gray-500 uppercase">{cur}</span>
            <span className="text-sm text-white font-medium">
              {obj[cur].toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl mb-4 overflow-hidden">
      <div className="px-4 py-3 border-b border-dark-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <i className="ri-pie-chart-line text-blue-400" />
          <p className="text-xs text-gray-400 uppercase tracking-wider">Spend by department</p>
        </div>
        <p className="text-[11px] text-gray-500">
          {totals.count} active credential{totals.count === 1 ? '' : 's'} across {orderedKeys.length} bucket{orderedKeys.length === 1 ? '' : 's'}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[11px] text-gray-500 uppercase tracking-wider bg-dark-900/40">
            <tr className="border-b border-dark-700">
              <th className="px-4 py-2.5 text-left font-medium">Department</th>
              <th className="px-4 py-2.5 text-right font-medium w-16">Creds</th>
              <th className="px-4 py-2.5 text-right font-medium">Monthly</th>
              <th className="px-4 py-2.5 text-right font-medium">Yearly</th>
              {showOneTime && <th className="px-4 py-2.5 text-right font-medium">One-time</th>}
              {showEstimated && <th className="px-4 py-2.5 text-right font-medium">Estimated /mo</th>}
            </tr>
          </thead>
          <tbody>
            {orderedKeys.map((k) => {
              const b = data.get(k)!;
              return (
                <tr key={k} className="border-b border-dark-700/40 hover:bg-dark-700/20 transition-colors">
                  <td className="px-4 py-3 text-white align-middle">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${k === 'orgwide' ? 'bg-amber-400' : 'bg-blue-400'}`} />
                      <span>{deptName(k)}</span>
                      {k === 'orgwide' && (
                        <span className="text-[10px] text-gray-500">(no dept)</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-xs tabular-nums align-middle">
                    {b.count > 0 ? (
                      <button
                        onClick={() => setInspectKey(k)}
                        className="text-emerald-300 hover:text-emerald-200 hover:underline focus:outline-none"
                        title={`View the ${b.count} credential${b.count === 1 ? '' : 's'} in this bucket`}
                      >
                        {b.count}
                      </button>
                    ) : (
                      <span className="text-gray-400">{b.count}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right align-middle"><CurrencyCell obj={b.monthly} /></td>
                  <td className="px-4 py-3 text-right align-middle"><CurrencyCell obj={b.yearly} /></td>
                  {showOneTime && <td className="px-4 py-3 text-right align-middle"><CurrencyCell obj={b.oneTime} /></td>}
                  {showEstimated && <td className="px-4 py-3 text-right align-middle"><CurrencyCell obj={b.est} /></td>}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-dark-900/40 border-t-2 border-dark-600">
            <tr>
              <td className="px-4 py-3 text-[11px] uppercase tracking-wider text-gray-400 font-semibold">Total</td>
              <td className="px-4 py-3 text-right text-xs tabular-nums font-semibold">
                {totals.count > 0 ? (
                  <button
                    onClick={() => setInspectKey('_all')}
                    className="text-emerald-300 hover:text-emerald-200 hover:underline focus:outline-none"
                    title={`View all ${totals.count} credentials across every bucket`}
                  >
                    {totals.count}
                  </button>
                ) : (
                  <span className="text-gray-300">{totals.count}</span>
                )}
              </td>
              <td className="px-4 py-3 text-right"><CurrencyCell obj={totals.monthly} /></td>
              <td className="px-4 py-3 text-right"><CurrencyCell obj={totals.yearly} /></td>
              {showOneTime && <td className="px-4 py-3 text-right"><CurrencyCell obj={totals.oneTime} /></td>}
              {showEstimated && <td className="px-4 py-3 text-right"><CurrencyCell obj={totals.est} /></td>}
            </tr>
          </tfoot>
        </table>
      </div>
      {inspectKey != null && (
        <DepartmentCredsModal
          deptKey={inspectKey}
          deptLabel={inspectKey === '_all'
            ? 'All departments'
            : deptName(inspectKey)}
          creds={inspectKey === '_all'
            ? [...data.values()].flatMap((b) => b.creds)
            : (data.get(inspectKey)?.creds ?? [])}
          onClose={() => setInspectKey(null)}
        />
      )}
    </div>
  );
}

// Modal listing the credentials inside one Spend-by-Department bucket.
// Triggered by clicking the count cell. Lists platform / category /
// billing / price so the admin can see what they're paying for in one
// glance — same shape as the Vault table but scoped to the bucket.
function DepartmentCredsModal({
  deptKey, deptLabel, creds, onClose,
}: {
  deptKey: string;
  deptLabel: string;
  creds: Credential[];
  onClose: () => void;
}) {
  const sorted = useMemo(
    () => [...creds].sort((a, b) => a.platform_name.localeCompare(b.platform_name)),
    [creds],
  );
  // Esc closes — keyboard parity with the other modals on this page.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-dark-700 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-500">Credentials in</p>
            <h3 className="text-base text-white font-semibold">
              {deptLabel}
              {deptKey === 'orgwide' && <span className="ml-2 text-[10px] text-gray-500">(no dept)</span>}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white rounded hover:bg-dark-700"
            aria-label="Close"
          >
            <i className="ri-close-line text-lg" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {sorted.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-500">No credentials in this bucket.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[11px] text-gray-500 uppercase tracking-wider bg-dark-900/40 sticky top-0">
                <tr className="border-b border-dark-700">
                  <th className="px-4 py-2.5 text-left font-medium">Platform</th>
                  <th className="px-4 py-2.5 text-left font-medium">Category</th>
                  <th className="px-4 py-2.5 text-left font-medium">Billing</th>
                  <th className="px-4 py-2.5 text-right font-medium">Price</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.id} className="border-b border-dark-700/40">
                    <td className="px-4 py-2.5 text-white">{r.platform_name}</td>
                    <td className="px-4 py-2.5 text-gray-300">{r.category ?? '—'}</td>
                    <td className="px-4 py-2.5 text-gray-300">{r.billing_cycle ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">
                      {r.price_amount != null
                        ? `${r.price_currency ?? ''} ${Number(r.price_amount).toLocaleString()}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-5 py-3 border-t border-dark-700 flex items-center justify-between text-[11px] text-gray-500">
          <span>{sorted.length} credential{sorted.length === 1 ? '' : 's'}</span>
          <button onClick={onClose} className="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-white rounded-md text-xs">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ============== Access map (who has access to what) ==============

type AccessRow = {
  credential_id: string;
  platform_name: string;
  category: string | null;
  billing_cycle: string | null;
  price_amount: number | null;
  price_currency: string | null;
  active: boolean;
  assignment_id: string;
  employee_id: string | null;
  user_name: string;
  delivery_email: string;
  sent_at: string;
  revoked_at: string | null;
};

function AccessMap() {
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [groupBy, setGroupBy] = useState<'platform' | 'user'>('platform');
  const [showRevoked, setShowRevoked] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('v_credential_access')
      .select('*')
      .order('platform_name')
      .order('user_name');
    setRows((data ?? []) as AccessRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (assignmentId: string, userName: string, platformName: string) => {
    if (!await confirmDialog({ title: `Revoke ${userName}'s access to ${platformName}? They will lose access immediately. This is logged in the audit trail.`, tone: 'danger' })) return;
    setRevokingId(assignmentId);
    // `select()` returns the rows the UPDATE actually modified. Under RLS,
    // a denied update silently returns 0 rows with no error — so checking
    // the count is the only way to surface the "you don't have permission"
    // case to the admin (otherwise the row just stays put and the button
    // looks like a no-op).
    const { data, error } = await supabase
      .from('credential_assignments')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: 'manual_revoke' })
      .eq('id', assignmentId)
      .select('id');
    setRevokingId(null);
    if (error) { notify.error('Could not revoke', { description: String(error.message) }); return; }
    if (!data || data.length === 0) {
      notify.error('Revoke failed: no rows updated.\n\n' +
        'Most likely the RLS policy that lets org owners/admins revoke access ' +
        'has not been applied to the database yet. Run migration ' +
        '0094_credential_assignments_admin_revoke.sql in the Supabase SQL editor, ' +
        'then try again.\n\n' +
        'If you are an owner/admin and this still fails, check your org_members.role.');
      return;
    }
    await load();
  };

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showRevoked && r.revoked_at) return false;
      if (!ql) return true;
      return [r.platform_name, r.user_name, r.delivery_email, r.category].filter(Boolean).join(' ').toLowerCase().includes(ql);
    });
  }, [rows, q, showRevoked]);

  const grouped = useMemo(() => {
    const map = new Map<string, AccessRow[]>();
    for (const r of filtered) {
      const key = groupBy === 'platform' ? r.platform_name : `${r.user_name}|${r.delivery_email}`;
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, groupBy]);

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl">
      <div className="p-4 flex flex-col md:flex-row gap-3 md:items-center border-b border-dark-700">
        <div className="flex-1 flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5">
          <i className="ri-search-line text-gray-500 text-sm mr-2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search user, email, platform…"
            className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none flex-1" />
        </div>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'platform' | 'user')}
          className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white">
          <option value="platform">Group by platform</option>
          <option value="user">Group by user</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
          Show revoked
        </label>
        <button
          onClick={() => setGrantOpen(true)}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium flex items-center gap-1.5 shrink-0"
        >
          <i className="ri-user-add-line text-sm" />
          Grant access
        </button>
      </div>

      {grantOpen && (
        <GrantAccessModal
          onClose={() => setGrantOpen(false)}
          onDone={async () => { setGrantOpen(false); await load(); }}
        />
      )}

      <div className="divide-y divide-dark-700">
        {loading ? (
          <p className="p-6 text-center text-sm text-gray-500">Loading…</p>
        ) : grouped.length === 0 ? (
          <p className="p-6 text-center text-sm text-gray-500">
            No access records yet. Use "Send selected to user" on the Vault tab or wait for an approved credential request.
          </p>
        ) : grouped.map(([key, items]) => {
          const head = groupBy === 'platform' ? items[0].platform_name : items[0].user_name;
          const sub = groupBy === 'platform'
            ? `${items.length} ${items.length === 1 ? 'user' : 'users'} · ${items[0].category ?? '—'}`
            : items[0].delivery_email;
          return (
            <div key={key} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="min-w-0">
                  <p className="text-sm text-white font-medium truncate">{head}</p>
                  <p className="text-xs text-gray-500 truncate">{sub}</p>
                </div>
                {groupBy === 'platform' && items[0].price_amount != null && (
                  <span className="text-xs text-gray-400">
                    {items[0].price_currency} {items[0].price_amount.toLocaleString()} / {items[0].billing_cycle ?? '—'}
                  </span>
                )}
              </div>
              <ul className="space-y-1">
                {items.map((r) => (
                  <li key={r.assignment_id} className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-dark-900/60 rounded-lg">
                    <div className="min-w-0">
                      <p className="text-sm text-white truncate">{groupBy === 'platform' ? r.user_name : r.platform_name}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {groupBy === 'platform' ? r.delivery_email : (r.category ?? '—')}
                        {' · sent '}{new Date(r.sent_at).toLocaleDateString()}
                      </p>
                    </div>
                    {r.revoked_at ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 flex-shrink-0">revoked</span>
                    ) : (
                      <button
                        onClick={() => revoke(r.assignment_id, r.user_name, r.platform_name)}
                        disabled={revokingId === r.assignment_id}
                        className="text-[11px] px-2 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 disabled:opacity-50 flex items-center gap-1 flex-shrink-0"
                        title="Revoke this user's access"
                      >
                        <i className="ri-close-circle-line" />
                        {revokingId === r.assignment_id ? 'Revoking…' : 'Revoke'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============== CSV import modal ==============
//
// Accepted columns (header row required, case-insensitive, order independent):
//   platform_name (required), password (required), category, login_url, username, notes,
//   tags (comma/semicolon-separated within the cell), billing_cycle, price_amount,
//   price_currency, seats_total, subscription_starts_at, subscription_ends_at,
//   owner_department (department name, resolved to id), is_shared_account, active.
//
// Header row is required. We parse client-side with a tiny RFC-4180-ish parser
// that supports quoted fields and embedded commas — enough for spreadsheet exports.

function CsvImportModal({
  onClose, onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; failed: number; outcomes: Array<{ index: number; ok: boolean; error?: string }> } | null>(null);

  const onFile = async (file: File) => {
    setErr(null); setResult(null);
    setFileName(file.name);
    const text = await file.text();
    try {
      const parsed = parseCsv(text);
      setRows(parsed);
    } catch (e) {
      setErr(`Could not parse CSV: ${(e as Error).message}`);
      setRows([]);
    }
  };

  const submit = async () => {
    if (!rows.length) return;
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cred-bulk-import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setResult(j as { imported: number; failed: number; outcomes: Array<{ index: number; ok: boolean; error?: string }> });
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const downloadTemplate = () => {
    const header = 'platform_name,password,category,login_url,username,notes,tags,billing_cycle,price_amount,price_currency,seats_total,subscription_starts_at,subscription_ends_at,owner_department,is_shared_account,active';
    const sample = 'Figma,P@ssw0rd!,design,https://figma.com,design@acme.com,Use SSO,"design,sso",yearly,144,USD,5,2025-01-01,2026-01-01,Design,true,true';
    const blob = new Blob([`${header}\n${sample}\n`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'wellness-extract-credentials-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg text-white font-semibold">Upload credentials from CSV</h2>
            <p className="text-xs text-gray-500">Bulk-import platforms with passwords, billing, and seats.</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>

        <div className="p-5 space-y-3 overflow-y-auto">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

          {!result && (
            <>
              <button onClick={downloadTemplate} className="text-xs text-emerald-400 hover:text-emerald-300">
                <i className="ri-download-line mr-1" /> Download CSV template
              </button>

              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">CSV file</span>
                <input type="file" accept=".csv,text/csv"
                  onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
                  className="block w-full text-sm text-gray-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-dark-700 file:text-white hover:file:bg-dark-600 cursor-pointer" />
              </label>

              {fileName && (
                <p className="text-xs text-gray-500">{fileName} — {rows.length} row{rows.length === 1 ? '' : 's'} parsed</p>
              )}

              {rows.length > 0 && (
                <div className="border border-dark-700 rounded-lg overflow-auto max-h-64">
                  <table className="w-full text-xs">
                    <thead className="text-gray-500 sticky top-0 bg-dark-800">
                      <tr>
                        {Object.keys(rows[0]).slice(0, 8).map((k) => (
                          <th key={k} className="px-3 py-2 text-left font-medium">{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 10).map((row, i) => (
                        <tr key={i} className="border-t border-dark-700/50">
                          {Object.keys(rows[0]).slice(0, 8).map((k) => (
                            <td key={k} className="px-3 py-1.5 text-gray-300 truncate max-w-[160px]">{row[k] ?? ''}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > 10 && <p className="px-3 py-2 text-xs text-gray-500">Showing first 10 of {rows.length}.</p>}
                </div>
              )}
            </>
          )}

          {result && (
            <div className="space-y-2">
              <p className="text-sm text-white">
                <span className="text-emerald-400">{result.imported} imported</span>
                {result.failed > 0 && <>, <span className="text-rose-400">{result.failed} failed</span></>}
              </p>
              {result.failed > 0 && (
                <div className="border border-rose-500/30 bg-rose-500/5 rounded-lg p-2 max-h-40 overflow-y-auto text-xs">
                  {result.outcomes.filter((o) => !o.ok).map((o) => (
                    <p key={o.index} className="text-rose-300">Row {o.index + 1}: {o.error}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">
          {!result ? (
            <>
              <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
              <button onClick={submit} disabled={rows.length === 0 || busy}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
                {busy ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <button onClick={onDone} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">Done</button>
          )}
        </footer>
      </div>
    </div>
  );
}

// Minimal RFC-4180-ish parser: header row → object per row. Supports quoted
// fields and embedded commas / newlines inside quotes. Doubled "" inside a
// quoted field is treated as a literal quote.
// Read a File as raw base64 (no data:URI prefix), suitable for sending to
// invoice-extract / vision APIs. Used by the modal's auto-extract flow.
function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    r.onerror = () => reject(new Error('file read failed'));
    r.readAsDataURL(f);
  });
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); row = []; cur = ''; }
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
      else cur += c;
    }
  }
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
  if (rows.length < 2) throw new Error('CSV must have a header row and at least one data row');
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = (r[i] ?? '').trim();
    return obj;
  });
}

// ============== Invoices tab ==============
//
// Cross-platform invoice ledger. Lists every invoice we've captured for any
// credential, with totals per currency × status. Manual add + CSV upload —
// per-provider API connectors land separately (Stripe / OpenAI / etc.).

type Invoice = {
  id: string;
  org_id: string;
  credential_id: string;
  invoice_number: string | null;
  issue_date: string | null;
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  amount: number | null;
  currency: string | null;
  status: 'paid' | 'pending' | 'overdue' | 'failed' | 'refunded' | 'draft';
  source: string;
  pdf_url: string | null;
  notes: string | null;
  // Attached file metadata (added in migration 0082). `attachment_path`
  // is an object key under the `credential-invoices` storage bucket;
  // the dashboard mints a signed URL on demand. NULL when only an
  // external pdf_url was recorded.
  attachment_path: string | null;
  attachment_mime: string | null;
  attachment_name: string | null;
  platform_name: string;
  subscription_model: string | null;
  category: string | null;
};

const INVOICE_STATUS_TINT: Record<Invoice['status'], string> = {
  paid:     'bg-emerald-500/15 text-emerald-400',
  pending:  'bg-amber-500/15 text-amber-400',
  overdue:  'bg-rose-500/15 text-rose-400',
  failed:   'bg-rose-500/15 text-rose-400',
  refunded: 'bg-gray-500/15 text-gray-400',
  draft:    'bg-blue-500/15 text-blue-400',
};

// Source-of-truth badge for each invoice row. Surfaces *how* the invoice
// reached us — API connector, inbound email, browser scrape, or manual
// upload — so the customer can spot which platforms still need a connector.
function sourceBadge(s: string): { label: string; cls: string } {
  if (s?.startsWith('api_')) return { label: s.replace('api_', 'API · '), cls: 'bg-cyan-500/15 text-cyan-300' };
  if (s === 'email')         return { label: 'Email',   cls: 'bg-violet-500/15 text-violet-300' };
  if (s === 'scrape')        return { label: 'Scraped', cls: 'bg-fuchsia-500/15 text-fuchsia-300' };
  if (s === 'csv')           return { label: 'CSV',     cls: 'bg-blue-500/15 text-blue-300' };
  return { label: s || 'Manual', cls: 'bg-gray-500/15 text-gray-300' };
}

// One-shot enqueue button used on each credential row + retry path. Shows
// a brief in-flight spinner; the actual progress is visible in the
// Fetch-status tab.
function TestFetchButton({ credId }: { credId: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const click = async () => {
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-test-fetch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential_id: credId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setDone(true);
      setTimeout(() => setDone(false), 4000);
    } catch (e) {
      notify.error('Test fetch failed', { description: String((e as Error).message) });
    } finally { setBusy(false); }
  };
  return (
    <button
      onClick={click}
      disabled={busy}
      className="text-xs text-cyan-400 hover:text-cyan-300 disabled:opacity-40"
      title="Queue a single invoice-fetch job now"
    >
      {busy ? '…' : done ? '✓ Queued' : 'Test fetch'}
    </button>
  );
}

// ============== Fetch-status tab ==============
// Shows the last ~50 invoice_fetch_jobs rows for the current org with
// inline retry + "enter OTP" actions. Lets the admin see at a glance
// which credentials are flowing automatically and which are stuck.

interface FetchJob {
  id: string;
  credential_id: string;
  billing_period_start: string;
  billing_period_end: string;
  tier: 'api' | 'email' | 'scrape';
  status: 'queued' | 'running' | 'success' | 'failed' | 'needs_otp' | 'needs_otp_timeout' | 'needs_human' | 'cancelled';
  attempts: number;
  last_error: string | null;
  result_invoice_id: string | null;
  created_at: string;
  completed_at: string | null;
}

const FETCH_STATUS_TINT: Record<FetchJob['status'], string> = {
  queued:            'bg-gray-500/15 text-gray-300',
  running:           'bg-blue-500/15 text-blue-300',
  success:           'bg-emerald-500/15 text-emerald-300',
  failed:            'bg-rose-500/15 text-rose-300',
  needs_otp:         'bg-amber-500/15 text-amber-300',
  needs_otp_timeout: 'bg-amber-500/10 text-amber-400',
  needs_human:       'bg-fuchsia-500/15 text-fuchsia-300',
  cancelled:         'bg-gray-500/10 text-gray-400',
};

function FetchStatusTab({ credentials }: { credentials: Credential[] }) {
  const [jobs, setJobs] = useState<FetchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const credMap = useMemo(() => {
    const m = new Map<string, Credential>();
    for (const c of credentials) m.set(c.id, c);
    return m;
  }, [credentials]);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('invoice_fetch_jobs')
      .select('id, credential_id, billing_period_start, billing_period_end, tier, status, attempts, last_error, result_invoice_id, created_at, completed_at')
      .order('created_at', { ascending: false })
      .limit(50);
    setJobs((data ?? []) as FetchJob[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const retry = async (credId: string) => {
    setRetryingId(credId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-test-fetch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential_id: credId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await load();
    } catch (e) {
      notify.error('Retry failed', { description: String((e as Error).message) });
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl">
      <div className="p-4 border-b border-dark-700 flex items-center justify-between">
        <div>
          <p className="text-sm text-white font-medium">Fetch jobs · last 50</p>
          <p className="text-[11px] text-gray-500">Daily cron enqueues these. Auto-forwarded to your accounts team on success.</p>
        </div>
        <button onClick={load} className="text-xs text-emerald-400 hover:text-emerald-300">Refresh</button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase tracking-wider">
            <tr className="border-b border-dark-700">
              <th className="px-4 py-3 text-left font-medium">Platform</th>
              <th className="px-4 py-3 text-left font-medium">Period</th>
              <th className="px-4 py-3 text-left font-medium">Tier</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Last error</th>
              <th className="px-4 py-3 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-500">Loading…</td></tr>
            ) : jobs.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-gray-500">No fetch jobs yet. Click "Test fetch" on any credential to queue one.</td></tr>
            ) : jobs.map((j) => {
              const cred = credMap.get(j.credential_id);
              const isOpen = j.status === 'queued' || j.status === 'running' || j.status === 'needs_otp';
              return (
                <tr key={j.id} className="border-b border-dark-700/50 hover:bg-dark-700/30">
                  <td className="px-4 py-3 text-white">{cred?.platform_name ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{j.billing_period_start} → {j.billing_period_end}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{j.tier}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-1 rounded-full ${FETCH_STATUS_TINT[j.status]}`}>{j.status}</span>
                    {j.attempts > 1 && <span className="ml-2 text-[10px] text-gray-500">×{j.attempts}</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs max-w-md truncate" title={j.last_error ?? ''}>{j.last_error ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    {!isOpen && cred && (
                      <button
                        onClick={() => void retry(cred.id)}
                        disabled={retryingId === cred.id}
                        className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                      >
                        {retryingId === cred.id ? '…' : 'Retry'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvoicesTab({ credentials, depts }: { credentials: Credential[]; depts: Department[] }) {
  const { canEdit, canDelete } = useAppAccess();
  const canWriteInv = canEdit('credentials');
  const canDeleteInv = canDelete('credentials');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Invoice['status']>('all');
  const [platformFilter, setPlatformFilter] = useState<'all' | string>('all');
  // Date-range filter on issue_date. Either bound is optional.
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rangeDeleteOpen, setRangeDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('v_credential_invoices').select('*').order('issue_date', { ascending: false, nullsFirst: false });
    setInvoices((data ?? []) as Invoice[]);
    setSelected(new Set());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return invoices.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (platformFilter !== 'all' && r.credential_id !== platformFilter) return false;
      if (dateFrom && (!r.issue_date || r.issue_date < dateFrom)) return false;
      if (dateTo   && (!r.issue_date || r.issue_date > dateTo))   return false;
      if (!ql) return true;
      // Global search — every field worth grepping. Numeric amount is
      // stringified so a user typing "1599" finds the matching row.
      const hay = [
        r.platform_name, r.invoice_number, r.notes, r.currency,
        r.status, r.source, r.category, r.subscription_model,
        r.issue_date, r.period_start, r.period_end, r.due_date,
        r.amount != null ? String(r.amount) : '',
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(ql);
    });
  }, [invoices, q, statusFilter, platformFilter, dateFrom, dateTo]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const toggleAll = () => {
    if (allFilteredSelected) {
      const next = new Set(selected);
      for (const r of filtered) next.delete(r.id);
      setSelected(next);
    } else {
      const next = new Set(selected);
      for (const r of filtered) next.add(r.id);
      setSelected(next);
    }
  };
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const callDelete = async (body: Record<string, unknown>): Promise<{ deleted: number; files_deleted: number }> => {
    const { data: { session } } = await supabase.auth.getSession();
    const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error ?? `delete failed (${resp.status})`);
    return j;
  };

  const deleteRow = async (r: Invoice) => {
    if (!await confirmDialog({ title: `Delete invoice "${r.invoice_number ?? '(no number)'}" for ${r.platform_name}? This removes the row and any attached file.`, tone: 'danger' })) return;
    try {
      await callDelete({ ids: [r.id] });
      await load();
    } catch (e) { notify.error('Delete failed', { description: String((e as Error).message) }); }
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!await confirmDialog({ title: `Delete ${selected.size} invoice${selected.size === 1 ? '' : 's'} and any attached files? This cannot be undone.`, tone: 'danger' })) return;
    setBulkBusy(true);
    try {
      const j = await callDelete({ ids: Array.from(selected) });
      notify.success(`Deleted ${j.deleted} invoice(s) + ${j.files_deleted} file(s).`);
      await load();
    } catch (e) { notify.error('Bulk delete failed', { description: String((e as Error).message) }); }
    setBulkBusy(false);
  };

  const totals = useMemo(() => {
    const byCurStatus: Record<string, Record<string, number>> = {};
    for (const r of filtered) {
      if (r.amount == null || !r.currency) continue;
      byCurStatus[r.currency] = byCurStatus[r.currency] ?? {};
      byCurStatus[r.currency][r.status] = (byCurStatus[r.currency][r.status] ?? 0) + Number(r.amount);
    }
    return byCurStatus;
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 flex flex-col md:flex-row gap-3 md:items-center justify-between">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wider">Totals (current filter)</p>
          {Object.keys(totals).length === 0 ? (
            <p className="text-sm text-gray-500 mt-1">No invoices in scope.</p>
          ) : (
            <div className="flex flex-wrap gap-x-5 gap-y-2 mt-1">
              {Object.entries(totals).sort().map(([cur, byStatus]) => (
                <div key={cur} className="text-sm">
                  <span className="text-xs text-gray-500 mr-1">{cur}</span>
                  {Object.entries(byStatus).map(([s, v]) => (
                    <span key={s} className="mr-3">
                      <span className={`text-xs ${INVOICE_STATUS_TINT[s as Invoice['status']]?.split(' ')[1] ?? 'text-gray-400'} mr-1`}>{s}:</span>
                      <span className="text-white font-medium">{v.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {canDeleteInv && (
            <button
              onClick={() => setRangeDeleteOpen(true)}
              className="px-3 py-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 rounded-lg text-xs"
              title="Delete every invoice within an issue-date range"
            >
              <i className="ri-calendar-close-line mr-1" /> Delete by date range
            </button>
          )}
          {canDeleteInv && selected.size > 0 && (
            <button
              disabled={bulkBusy}
              onClick={() => void deleteSelected()}
              className="px-3 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 rounded-lg text-xs text-white"
            >
              <i className="ri-delete-bin-6-line mr-1" />
              {bulkBusy ? 'Deleting…' : `Delete selected (${selected.size})`}
            </button>
          )}
          {canWriteInv && (
            <button onClick={() => setCsvOpen(true)} className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white">
              <i className="ri-file-upload-line mr-1" /> Upload CSV
            </button>
          )}
          {canWriteInv && (
            <button onClick={() => setAdding(true)} className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">
              <i className="ri-add-line mr-1" /> Add invoice
            </button>
          )}
        </div>
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl">
        <div className="p-4 flex flex-col gap-3 border-b border-dark-700">
          <div className="flex flex-col md:flex-row gap-3 md:items-center">
            <div className="flex-1 flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5">
              <i className="ri-search-line text-gray-500 text-sm mr-2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search invoice # / platform / amount / notes / dates…"
                className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none flex-1" />
            </div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white">
              <option value="all">All statuses</option>
              <option value="paid">Paid</option>
              <option value="pending">Pending</option>
              <option value="overdue">Overdue</option>
              <option value="failed">Failed</option>
              <option value="refunded">Refunded</option>
              <option value="draft">Draft</option>
            </select>
            <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}
              className="bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-sm text-white">
              <option value="all">All platforms</option>
              {credentials.map((c) => <option key={c.id} value={c.id}>{c.platform_name}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap gap-2 items-center text-xs text-gray-400">
            <span className="text-[11px] uppercase tracking-wider">Issue date</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="bg-dark-900 border border-dark-700 rounded-lg px-2 py-1 text-xs text-white"
            />
            <span className="text-gray-500">→</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="bg-dark-900 border border-dark-700 rounded-lg px-2 py-1 text-xs text-white"
            />
            {(dateFrom || dateTo) && (
              <button
                onClick={() => { setDateFrom(''); setDateTo(''); }}
                className="text-[11px] text-gray-400 hover:text-white underline"
              >Clear</button>
            )}
            {/* Quick presets — common SaaS-finance views. */}
            <span className="text-gray-600 mx-2">|</span>
            {([
              { label: 'This month', range: 'thisMonth' },
              { label: 'Last month', range: 'lastMonth' },
              { label: 'This year',  range: 'thisYear' },
            ] as const).map((p) => (
              <button
                key={p.range}
                onClick={() => {
                  const t = new Date();
                  if (p.range === 'thisMonth') {
                    setDateFrom(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`);
                    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0);
                    setDateTo(last.toISOString().slice(0, 10));
                  } else if (p.range === 'lastMonth') {
                    const start = new Date(t.getFullYear(), t.getMonth() - 1, 1);
                    const end   = new Date(t.getFullYear(), t.getMonth(), 0);
                    setDateFrom(start.toISOString().slice(0, 10));
                    setDateTo(end.toISOString().slice(0, 10));
                  } else {
                    setDateFrom(`${t.getFullYear()}-01-01`);
                    setDateTo(`${t.getFullYear()}-12-31`);
                  }
                }}
                className="text-[11px] px-2 py-0.5 rounded bg-dark-700 hover:bg-dark-600 text-gray-300"
              >{p.label}</button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 uppercase tracking-wider">
              <tr className="border-b border-dark-700">
                {canDeleteInv && (
                  <th className="px-3 py-3 w-8">
                    <input type="checkbox" checked={allFilteredSelected} onChange={toggleAll} />
                  </th>
                )}
                <th className="px-4 py-3 text-left font-medium">Platform</th>
                <th className="px-4 py-3 text-left font-medium">Invoice #</th>
                <th className="px-4 py-3 text-left font-medium">Issue date</th>
                <th className="px-4 py-3 text-left font-medium">Period</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">File</th>
                <th className="px-4 py-3 text-left font-medium">Source</th>
                <th className="px-4 py-3 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-gray-500">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-gray-500">
                  No invoices yet. Add one manually, upload a CSV, or wait for an API connector to sync.
                </td></tr>
              ) : filtered.map((r) => (
                <tr key={r.id} className="border-b border-dark-700/50 hover:bg-dark-700/30">
                  {canDeleteInv && (
                    <td className="px-3 py-3 text-center">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} />
                    </td>
                  )}
                  <td className="px-4 py-3 text-white">
                    <p>{r.platform_name}</p>
                    {r.subscription_model && <p className="text-[10px] text-gray-500">{r.subscription_model}</p>}
                  </td>
                  <td className="px-4 py-3 text-gray-300 font-mono text-xs">{r.invoice_number ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-300">{r.issue_date ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-300 text-xs">
                    {r.period_start && r.period_end ? `${r.period_start} → ${r.period_end}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-300">
                    {r.amount != null ? `${r.currency ?? ''} ${r.amount.toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-1 rounded-full ${INVOICE_STATUS_TINT[r.status]}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <InvoiceAttachmentLink invoice={r} />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {(() => {
                      const b = sourceBadge(r.source);
                      return <span className={`px-2 py-1 rounded-full ${b.cls}`}>{b.label}</span>;
                    })()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-3">
                      {canWriteInv && <button onClick={() => setEditing(r)} className="text-xs text-emerald-400 hover:text-emerald-300">Edit</button>}
                      {canDeleteInv && (
                        <button onClick={() => void deleteRow(r)} className="text-xs text-rose-400 hover:text-rose-300">
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 border-t border-dark-700 flex items-center justify-between">
          <p className="text-xs text-gray-500">{filtered.length} of {invoices.length} invoices</p>
        </div>
      </div>

      {(adding || editing) && (
        <InvoiceModal
          invoice={editing}
          credentials={credentials}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={async () => { setAdding(false); setEditing(null); await load(); }}
        />
      )}
      {csvOpen && (
        <InvoiceCsvModal
          credentials={credentials}
          onClose={() => setCsvOpen(false)}
          onDone={async () => { setCsvOpen(false); await load(); }}
        />
      )}
      {rangeDeleteOpen && (
        <RangeDeleteModal
          credentials={credentials}
          onClose={() => setRangeDeleteOpen(false)}
          onDone={async () => { setRangeDeleteOpen(false); await load(); }}
        />
      )}
      {/* Suppress unused-warning on depts — kept for future per-dept invoice grouping. */}
      <span hidden>{depts.length}</span>
    </div>
  );
}

// Signed-URL link for an attached file. The storage bucket is private,
// so we mint a 5-min signed URL on click instead of putting it in the
// table render (would generate N URLs per page load for nothing). Falls
// back to the legacy `pdf_url` external link when there is no attachment.
function InvoiceAttachmentLink({ invoice }: { invoice: Invoice }) {
  const [busy, setBusy] = useState(false);
  if (!invoice.attachment_path) {
    if (invoice.pdf_url) {
      return <a href={invoice.pdf_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">External link</a>;
    }
    return <span className="text-gray-600">—</span>;
  }
  const open = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.storage
        .from('credential-invoices')
        .createSignedUrl(invoice.attachment_path!, 60 * 5);
      if (error || !data?.signedUrl) throw new Error(error?.message ?? 'no url');
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (e) {
      notify.error('Could not open file', { description: String((e as Error).message) });
    } finally { setBusy(false); }
  };
  const icon = invoice.attachment_mime?.startsWith('image/') ? 'ri-image-line' : 'ri-file-pdf-2-line';
  const label = invoice.attachment_name ?? (invoice.attachment_mime?.startsWith('image/') ? 'Image' : 'PDF');
  return (
    <button onClick={open} disabled={busy} className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 disabled:opacity-50">
      <i className={icon} />
      <span className="truncate max-w-[160px]" title={label}>{busy ? 'Opening…' : label}</span>
    </button>
  );
}

function RangeDeleteModal({ credentials, onClose, onDone }: {
  credentials: Credential[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [credId, setCredId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    if (!from && !to) { setErr('Pick at least one date'); return; }
    const scope = credId ? ` for ${credentials.find((c) => c.id === credId)?.platform_name ?? 'selected credential'}` : '';
    const range = `${from || 'beginning'} → ${to || 'today'}`;
    if (!await confirmDialog({ title: `Delete EVERY invoice${scope} dated ${range}? This cannot be undone.`, tone: 'danger' })) return;
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date_from: from || undefined,
          date_to:   to   || undefined,
          credential_id: credId || undefined,
        }),
      });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error ?? `${resp.status}`);
      notify.success(`Deleted ${j.deleted} invoice(s) + ${j.files_deleted} file(s).`);
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between mb-4">
          <h2 className="text-lg text-white font-semibold">Delete by date range</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>
        <p className="text-xs text-gray-400 mb-3">
          Removes every invoice whose <strong className="text-white">issue date</strong> falls in this range
          (and its attached file, if any). Leave a date blank for an open-ended bound.
        </p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
            </Field>
            <Field label="To">
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <Field label="Limit to platform (optional)">
            <select value={credId} onChange={(e) => setCredId(e.target.value)} className={inputCls}>
              <option value="">— all platforms —</option>
              {credentials.map((c) => <option key={c.id} value={c.id}>{c.platform_name}</option>)}
            </select>
          </Field>
          {err && <p className="text-xs text-rose-300">{err}</p>}
        </div>
        <footer className="flex justify-end gap-2 mt-5">
          <button disabled={busy} onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
          <button disabled={busy} onClick={run} className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
            {busy ? 'Deleting…' : 'Delete range'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function InvoiceModal({ invoice, credentials, onClose, onSaved }: {
  invoice: Invoice | null;
  credentials: Credential[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [credId, setCredId] = useState(invoice?.credential_id ?? '');
  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoice_number ?? '');
  const [issueDate, setIssueDate] = useState(invoice?.issue_date ?? '');
  const [periodStart, setPeriodStart] = useState(invoice?.period_start ?? '');
  const [periodEnd, setPeriodEnd] = useState(invoice?.period_end ?? '');
  const [dueDate, setDueDate] = useState(invoice?.due_date ?? '');
  const [amount, setAmount] = useState<string>(invoice?.amount != null ? String(invoice.amount) : '');
  const [currency, setCurrency] = useState(invoice?.currency ?? 'INR');
  const [status, setStatus] = useState<Invoice['status']>(invoice?.status ?? 'pending');
  const [pdfUrl, setPdfUrl] = useState(invoice?.pdf_url ?? '');
  const [notes, setNotes] = useState(invoice?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Attached file state. `file` = a freshly picked File (not yet
  // uploaded). `attachment` = the saved attachment metadata for the
  // current row (either from `invoice` or from a successful upload
  // during this open). `dragOver` toggles the drop-zone tint.
  const [file, setFile] = useState<File | null>(null);
  const [attachment, setAttachment] = useState<{
    path: string | null; mime: string | null; name: string | null;
  }>({
    path: invoice?.attachment_path ?? null,
    mime: invoice?.attachment_mime ?? null,
    name: invoice?.attachment_name ?? null,
  });
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  // LLM auto-extraction state. Fires on file pick (PDF only — vision can't
  // parse JPG/PNG receipts as reliably). Populates the form fields the
  // user can still override before save.
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState<string | null>(null);

  // Accept these client-side too — server (storage bucket) re-enforces
  // via allowed_mime_types in migration 0082, but failing early gives
  // a nicer message.
  const ACCEPTED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  const MAX_BYTES = 25 * 1024 * 1024;

  const pickFile = (f: File | null) => {
    setErr(null);
    setExtractNote(null);
    if (!f) { setFile(null); return; }
    if (!ACCEPTED_MIME.includes(f.type)) { setErr(`Unsupported file type: ${f.type || 'unknown'}. Use PDF, PNG, JPG or WEBP.`); return; }
    if (f.size > MAX_BYTES) { setErr(`File too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Max 25 MB.`); return; }
    setFile(f);
    // Only auto-extract for PDFs and only when creating (not editing). The
    // user may still override any field after Claude fills it in.
    if (!invoice && f.type === 'application/pdf') void autoExtract(f);
  };

  // Fires invoice-extract with the PDF, then merges results into form
  // fields. Never overwrites a field the user has already typed into.
  const autoExtract = async (f: File) => {
    setExtracting(true);
    setExtractNote(null);
    try {
      const b64 = await fileToBase64(f);
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-extract`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf_base64: b64, filename: f.name }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      const ex = j.extracted ?? {};
      // Merge only into empty fields — user keeps control of edits.
      if (!invoiceNumber && ex.invoice_number) setInvoiceNumber(ex.invoice_number);
      if (!issueDate && ex.issue_date) setIssueDate(ex.issue_date);
      if (!periodStart && ex.period_start) setPeriodStart(ex.period_start);
      if (!periodEnd && ex.period_end) setPeriodEnd(ex.period_end);
      if (!dueDate && ex.due_date) setDueDate(ex.due_date);
      if (!amount && ex.amount != null) setAmount(String(ex.amount));
      if (ex.currency && currency === 'INR') setCurrency(ex.currency);   // INR is the default we want to override
      if (ex.status) setStatus(ex.status);
      if (!notes && ex.notes) setNotes(ex.notes);
      if (!credId && j.matched_credential_id) setCredId(j.matched_credential_id);

      const matched = j.matched_credential_platform;
      const vendor = ex.vendor_name;
      setExtractNote(
        matched
          ? `Auto-filled from ${vendor ?? 'PDF'} → matched to ${matched}`
          : vendor
            ? `Auto-filled from ${vendor} (no matching credential found — leave platform unset or pick manually)`
            : 'Auto-filled from PDF',
      );
    } catch (e) {
      setExtractNote(`Auto-extract failed — fill manually. (${(e as Error).message})`);
    } finally {
      setExtracting(false);
    }
  };

  const uploadIfNeeded = async (): Promise<{ path: string | null; mime: string | null; name: string | null }> => {
    if (!file) return attachment;
    setUploading(true);
    try {
      // Path scheme: `<org_id>/<credential_id-or-_unassigned>/<uuid>.<ext>`.
      // RLS policy gates on first folder = org_id, so unassigned uploads
      // still satisfy storage policy as long as we resolve the org.
      let orgId: string | undefined = credentials.find((c) => c.id === credId)?.org_id;
      if (!orgId) {
        // No credential picked — fall back to any credential's org_id
        // (all rows in `credentials` already belong to caller's org).
        orgId = credentials[0]?.org_id;
      }
      if (!orgId) throw new Error('Cannot resolve org for upload — add a credential first or pick one');
      const folder = credId || '_unassigned';
      const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase().slice(0, 6);
      const objectKey = `${orgId}/${folder}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from('credential-invoices')
        .upload(objectKey, file, {
          contentType: file.type,
          upsert: false,
          cacheControl: '3600',
        });
      if (error) throw new Error(error.message);
      return { path: objectKey, mime: file.type, name: file.name };
    } finally { setUploading(false); }
  };

  const clearAttachment = () => {
    setFile(null);
    setAttachment({ path: null, mime: null, name: null });
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const finalAttachment = await uploadIfNeeded();
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: invoice?.id,
          credential_id: credId || null,
          invoice_number: invoiceNumber || null,
          issue_date: issueDate || null,
          period_start: periodStart || null,
          period_end: periodEnd || null,
          due_date: dueDate || null,
          amount: amount === '' ? null : Number(amount),
          currency,
          status,
          pdf_url: pdfUrl || null,
          notes: notes || null,
          attachment_path: finalAttachment.path,
          attachment_mime: finalAttachment.mime,
          attachment_name: finalAttachment.name,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-lg max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
          <h2 className="text-lg text-white font-semibold">{invoice ? 'Edit invoice' : 'Add invoice'}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>
        <div className="p-5 space-y-3 overflow-y-auto">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}
          {!invoice && (
            <div className="px-3 py-2 rounded-lg text-[11px] bg-emerald-500/5 border border-emerald-500/20 text-emerald-200">
              💡 Drop any invoice PDF below — we'll auto-fill the rest. Only the file is required.
            </div>
          )}

          {/* Move the file drop to the TOP so it's the first action. The
              upload triggers Claude vision extraction for PDFs. */}
          <Field label={invoice ? 'Invoice file' : 'Invoice file *'}>
            {attachment.path && !file ? (
              <div className="flex items-center justify-between bg-dark-900 border border-dark-700 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <i className={attachment.mime?.startsWith('image/') ? 'ri-image-line text-blue-400' : 'ri-file-pdf-2-line text-rose-400'} />
                  <span className="text-xs text-white truncate" title={attachment.name ?? ''}>{attachment.name ?? 'Attached file'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-emerald-400 hover:text-emerald-300 cursor-pointer">
                    Replace
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <button onClick={clearAttachment} className="text-[11px] text-rose-400 hover:text-rose-300">Remove</button>
                </div>
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault(); setDragOver(false);
                  pickFile(e.dataTransfer.files?.[0] ?? null);
                }}
                className={`border-2 border-dashed rounded-lg px-4 py-6 text-center transition-colors ${
                  dragOver ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-dark-700 bg-dark-900'
                }`}
              >
                {file ? (
                  <div className="flex items-center justify-center gap-2">
                    <i className={file.type.startsWith('image/') ? 'ri-image-line text-blue-400' : 'ri-file-pdf-2-line text-rose-400'} />
                    <span className="text-xs text-white truncate" title={file.name}>{file.name}</span>
                    <span className="text-[10px] text-gray-500">({(file.size / 1024).toFixed(0)} KB)</span>
                    <button onClick={() => setFile(null)} className="text-[10px] text-rose-400 hover:text-rose-300 ml-2">remove</button>
                  </div>
                ) : (
                  <>
                    <i className="ri-upload-cloud-2-line text-2xl text-gray-500 block mb-1" />
                    <p className="text-xs text-gray-300">Drop PDF / PNG / JPG here</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      or{' '}
                      <label className="text-emerald-400 hover:text-emerald-300 underline cursor-pointer">
                        browse
                        <input
                          type="file"
                          accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                        />
                      </label>
                      {' '}from your computer · max 25 MB
                    </p>
                  </>
                )}
              </div>
            )}
            {extracting && (
              <p className="text-[11px] text-cyan-400 mt-1 animate-pulse">
                <i className="ri-magic-line mr-1" /> Reading invoice with Claude…
              </p>
            )}
            {extractNote && !extracting && (
              <p className={`text-[11px] mt-1 ${extractNote.includes('failed') ? 'text-amber-400' : 'text-emerald-400'}`}>
                {extractNote.includes('failed') ? '⚠ ' : '✓ '}{extractNote}
              </p>
            )}
            {uploading && <p className="text-[11px] text-gray-500 mt-1">Uploading…</p>}
          </Field>

          <Field label="Platform / credential (optional — auto-matched from PDF)">
            <select value={credId} onChange={(e) => setCredId(e.target.value)} className={inputCls}>
              <option value="">— Unassigned —</option>
              {credentials.map((c) => <option key={c.id} value={c.id}>{c.platform_name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Invoice number">
              <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className={inputCls} placeholder="INV-2026-0042" />
            </Field>
            <Field label="Issue date">
              <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Period start">
              <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Period end">
              <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label="Amount">
              <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} placeholder="0.00" />
            </Field>
            <Field label="Currency">
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as Invoice['status'])} className={inputCls}>
                <option value="pending">Pending</option>
                <option value="paid">Paid</option>
                <option value="overdue">Overdue</option>
                <option value="failed">Failed</option>
                <option value="refunded">Refunded</option>
                <option value="draft">Draft</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due date">
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
            </Field>
            <Field label="External link (optional)">
              <input value={pdfUrl} onChange={(e) => setPdfUrl(e.target.value)} className={inputCls} placeholder="https://… (use only if not uploading a file)" />
            </Field>
          </div>

          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={`${inputCls} h-16 resize-none`} placeholder="Anything else worth recording" />
          </Field>
        </div>
        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">
          <button disabled={busy} onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
          <button
            disabled={busy || extracting || (!invoice && !file && !attachment.path)}
            onClick={save}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium"
            title={!invoice && !file && !attachment.path ? 'Drop an invoice file first' : ''}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function InvoiceCsvModal({ credentials, onClose, onDone }: { credentials: Credential[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; updated: number; failed: number; outcomes: Array<{ index: number; ok: boolean; error?: string }> } | null>(null);

  const onFile = async (file: File) => {
    setErr(null); setResult(null); setFileName(file.name);
    try { setRows(parseCsv(await file.text())); } catch (e) { setErr((e as Error).message); setRows([]); }
  };

  const submit = async () => {
    if (!rows.length) return;
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-bulk-import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setResult(j);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const downloadTemplate = () => {
    const header = 'platform_name,invoice_number,issue_date,period_start,period_end,due_date,amount,currency,status,pdf_url,notes';
    const sample = 'Figma,FIG-2026-04,2026-04-01,2026-04-01,2026-04-30,2026-04-15,144,USD,paid,https://invoice.example/abc,Q2 seat true-up';
    const blob = new Blob([`${header}\n${sample}\n`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'wellness-extract-invoices-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700">
          <h2 className="text-lg text-white font-semibold">Upload invoices CSV</h2>
          <p className="text-xs text-gray-500 mt-0.5">platform_name resolves to the credential in your vault. (credential_id is also accepted.)</p>
        </header>
        <div className="p-5 space-y-3 overflow-y-auto">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}
          {!result && (
            <>
              <button onClick={downloadTemplate} className="text-xs text-emerald-400 hover:text-emerald-300">
                <i className="ri-download-line mr-1" /> Download CSV template
              </button>
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">CSV file</span>
                <input type="file" accept=".csv,text/csv"
                  onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
                  className="block w-full text-sm text-gray-300 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-dark-700 file:text-white hover:file:bg-dark-600 cursor-pointer" />
              </label>
              {fileName && <p className="text-xs text-gray-500">{fileName} — {rows.length} row{rows.length === 1 ? '' : 's'} parsed. Existing invoices (same number) will be updated.</p>}
            </>
          )}
          {result && (
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-emerald-400">{result.imported} new</span>
                {result.updated > 0 && <>, <span className="text-blue-400">{result.updated} updated</span></>}
                {result.failed > 0 && <>, <span className="text-rose-400">{result.failed} failed</span></>}
              </p>
              {result.failed > 0 && (
                <div className="border border-rose-500/30 bg-rose-500/5 rounded-lg p-2 max-h-40 overflow-y-auto text-xs">
                  {result.outcomes.filter((o) => !o.ok).map((o) => (
                    <p key={o.index} className="text-rose-300">Row {o.index + 1}: {o.error}</p>
                  ))}
                </div>
              )}
            </div>
          )}
          <span hidden>{credentials.length}</span>
        </div>
        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">
          {!result ? (
            <>
              <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
              <button disabled={!rows.length || busy} onClick={submit} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
                {busy ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <button onClick={onDone} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">Done</button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ============== Connector actions (Connect API + Sync now) ==============
//
// Lives on each vault row when the credential has a billing_api_provider set.
// First click: prompt for the API token (single field for Stripe/OpenAI, two
// fields for Razorpay). Subsequent clicks: trigger sync. The token itself is
// never echoed back — only `billing_api_connected: true` and the last-sync
// timestamp are exposed via credentials_safe.

function ConnectorActions({ cred, onChanged }: { cred: Credential; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const provider = cred.billing_api_provider!;
  const connected = cred.billing_api_connected;

  const sync = async () => {
    setBusy(true); setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential_id: cred.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setMsg({ kind: 'ok', text: `${j.imported ?? 0} new, ${j.updated ?? 0} updated` });
      await onChanged();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(false); }
  };

  // Some providers don't have a public invoice API — show explainer only.
  const supported = provider === 'stripe' || provider === 'razorpay';

  return (
    <>
      {connected ? (
        <button
          onClick={sync}
          disabled={busy || !supported}
          title={cred.billing_api_last_synced_at ? `Last synced ${new Date(cred.billing_api_last_synced_at).toLocaleString()}` : 'Never synced'}
          className={`text-xs ${supported ? 'text-blue-400 hover:text-blue-300' : 'text-gray-500'} disabled:opacity-50`}
        >
          {busy ? 'Syncing…' : (supported ? 'Sync' : `${provider} (manual only)`)}
        </button>
      ) : (
        <button onClick={() => setOpen(true)} className="text-xs text-amber-400 hover:text-amber-300">
          Connect API
        </button>
      )}
      {msg && (
        <span className={`text-[10px] ${msg.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>{msg.text}</span>
      )}

      {open && (
        <ConnectorModal
          cred={cred}
          onClose={() => setOpen(false)}
          onSaved={async () => { setOpen(false); await onChanged(); }}
        />
      )}
    </>
  );
}

function ConnectorModal({ cred, onClose, onSaved }: { cred: Credential; onClose: () => void; onSaved: () => Promise<void> }) {
  const provider = cred.billing_api_provider!;
  const dual = provider === 'razorpay';
  const [token, setToken] = useState('');
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-connector-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential_id: cred.id,
          provider,
          ...(dual ? { key_id: keyId, key_secret: keySecret } : { token }),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const help: Record<string, { hint: string; format: string }> = {
    stripe:    { hint: 'Use a restricted key with the "Invoices: read" permission from Stripe Dashboard → Developers → API keys.', format: 'sk_live_… or rk_live_…' },
    razorpay:  { hint: 'Razorpay Dashboard → Account & Settings → API Keys.', format: 'key_id starts with rzp_…' },
    openai:    { hint: 'OpenAI does not expose a public invoice API. Use CSV upload or manual entry for now.', format: '—' },
    anthropic: { hint: 'Anthropic does not expose a public invoice API. Use CSV upload or manual entry for now.', format: '—' },
    aws:       { hint: 'AWS billing requires SigV4-signed Cost Explorer calls — connector coming separately.', format: '—' },
    other:     { hint: 'No built-in connector for this provider. Connect via CSV upload or manual entry instead.', format: '—' },
  };
  const info = help[provider] ?? help.other;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700">
          <h2 className="text-lg text-white font-semibold">Connect {provider} API</h2>
          <p className="text-xs text-gray-500 mt-0.5">{info.hint}</p>
        </header>
        <div className="p-5 space-y-3">
          {err && <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

          {dual ? (
            <>
              <Field label="Key ID">
                <input value={keyId} onChange={(e) => setKeyId(e.target.value)} className={inputCls} placeholder="rzp_live_…" />
              </Field>
              <Field label="Key Secret">
                <input type="password" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} className={inputCls} placeholder="••••" />
              </Field>
            </>
          ) : (
            <Field label={`API token (${info.format})`}>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className={inputCls} placeholder="sk_live_…" />
            </Field>
          )}

          <p className="text-[11px] text-gray-500">
            The token is encrypted at rest using the vault key and decrypted only inside the sync function. We never store it in plain text and never echo it back.
          </p>
        </div>
        <footer className="px-5 py-3 border-t border-dark-700 flex justify-between gap-2">
          {cred.billing_api_connected && (
            <button
              onClick={async () => {
                if (!await confirmDialog({ title: 'Disconnect API token? Synced invoices will remain.' })) return;
                try {
                  const { data: { session } } = await supabase.auth.getSession();
                  await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-connector-save`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ credential_id: cred.id, provider: null }),
                  });
                  await onSaved();
                } catch (e) { setErr((e as Error).message); }
              }}
              className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-rose-400">
              Disconnect
            </button>
          )}
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
            <button onClick={save} disabled={busy || (dual ? (!keyId || !keySecret) : !token)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
              {busy ? 'Saving…' : 'Save token'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ============== CSV export ==============
//
// Exports the currently-filtered vault list. Passwords are NEVER included —
// the safe view doesn't even surface them, and even if it did we'd strip
// here. Department UUIDs are resolved to names so the sheet is self-contained.

// Full-fat CSV export: includes every billing/usage field AND the list
// of employees each credential is currently assigned to. Pulls active
// (non-revoked) credential_assignments + joins employees so accounting
// gets ONE sheet showing platform → cost → who has access → next renewal
// without cross-referencing four tables.
async function exportCredentialsCsv(rows: Credential[], depts: Department[]) {
  const deptName = new Map(depts.map((d) => [d.id, d.name]));

  // Fetch active assignments for ALL credentials in the export in one
  // round-trip. employees!inner ensures we drop orphan rows where the
  // employee was deleted but the assignment wasn't (shouldn't happen due
  // to FK CASCADE, but defensive). delivery_email is the address the
  // password was sent to, useful when an employee has multiple addresses.
  const credIds = rows.map((r) => r.id);
  const assignByCred = new Map<string, { name: string; email: string; sent_at: string }[]>();
  if (credIds.length > 0) {
    const { data: assignments } = await supabase
      .from('credential_assignments')
      .select('credential_id, delivery_email, sent_at, employees!inner(full_name, work_email)')
      .in('credential_id', credIds)
      .is('revoked_at', null);
    type Row = {
      credential_id: string;
      delivery_email: string | null;
      sent_at: string;
      employees: { full_name: string | null; work_email: string | null } | null;
    };
    for (const a of (assignments ?? []) as Row[]) {
      const name = a.employees?.full_name ?? '—';
      const email = a.delivery_email ?? a.employees?.work_email ?? '';
      const list = assignByCred.get(a.credential_id) ?? [];
      list.push({ name, email, sent_at: a.sent_at });
      assignByCred.set(a.credential_id, list);
    }
  }

  const headers = [
    'platform_name', 'category', 'login_url', 'username', 'department',
    'tags', 'subscription_model', 'billing_cycle',
    'price_amount', 'price_currency', 'estimated_amount',
    'seats_total', 'assigned_count', 'assigned_users', 'assigned_emails',
    'subscription_starts_at', 'subscription_ends_at',
    'is_shared_account', 'active', 'billing_api_provider', 'billing_api_connected',
    'billing_api_last_synced_at', 'last_rotated_at', 'notes', 'created_at',
  ];
  const data = rows.map((r) => {
    const assigned = assignByCred.get(r.id) ?? [];
    return {
      platform_name: r.platform_name,
      category: r.category,
      login_url: r.login_url,
      username: r.username,
      department: r.owner_dept_id ? (deptName.get(r.owner_dept_id) ?? '') : 'Org-wide',
      tags: Array.isArray(r.tags) ? r.tags.join(';') : '',
      subscription_model: r.subscription_model,
      billing_cycle: r.billing_cycle,
      price_amount: r.price_amount,
      price_currency: r.price_currency,
      estimated_amount: r.estimated_amount,
      seats_total: r.seats_total,
      assigned_count: assigned.length,
      assigned_users: assigned.map((a) => a.name).join('; '),
      assigned_emails: assigned.map((a) => a.email).filter(Boolean).join('; '),
      subscription_starts_at: r.subscription_starts_at,
      subscription_ends_at: r.subscription_ends_at,
      is_shared_account: r.is_shared_account,
      active: r.active,
      billing_api_provider: r.billing_api_provider,
      billing_api_connected: r.billing_api_connected,
      billing_api_last_synced_at: r.billing_api_last_synced_at,
      last_rotated_at: r.last_rotated_at,
      notes: r.notes,
      created_at: r.created_at,
    };
  });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsvCreds(`wellness-extract-credentials-.csv`, headers, data);
}

function downloadCsvCreds(filename: string, headers: string[], rows: Record<string, unknown>[]) {
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const csv = '﻿' + [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ============== Grant access modal ==============
// Multi-credential × multi-employee picker. Picks credentials from the vault,
// picks employees (and optionally directory groups whose members get auto-
// expanded), then posts to /functions/v1/cred-grant-access which inserts the
// credential_assignments rows. No email is dispatched here — purely an
// access-rights record. Customer can later use "Send to user" on the Vault
// tab to actually deliver the password.

function GrantAccessModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  type CredOpt = { id: string; platform_name: string; category: string | null };
  type EmpOpt  = { id: string; full_name: string; work_email: string | null; designation: string | null };
  type GroupOpt = { id: string; display_name: string | null; provider: string; members_count: number };

  const [creds, setCreds] = useState<CredOpt[]>([]);
  const [emps,  setEmps]  = useState<EmpOpt[]>([]);
  const [groups, setGroups] = useState<GroupOpt[]>([]);
  const [loading, setLoading] = useState(true);

  const [selCreds, setSelCreds] = useState<Set<string>>(new Set());
  const [selEmps,  setSelEmps]  = useState<Set<string>>(new Set());
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set());

  const [credQuery, setCredQuery] = useState('');
  const [empQuery, setEmpQuery] = useState('');
  const [groupQuery, setGroupQuery] = useState('');
  const [tab, setTab] = useState<'employees' | 'groups'>('employees');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [c, e, g] = await Promise.all([
        supabase.from('credentials_safe')
          .select('id, platform_name, category, active')
          .eq('active', true)
          .order('platform_name')
          .range(0, 999),
        supabase.from('employees')
          .select('id, full_name, work_email, designation, status')
          .eq('status', 'active')
          .order('full_name')
          .range(0, 999),
        supabase.from('directory_groups')
          .select('id, display_name, provider, members_count')
          .order('display_name')
          .range(0, 999),
      ]);
      setCreds((c.data ?? []) as CredOpt[]);
      setEmps((e.data ?? []) as EmpOpt[]);
      setGroups((g.data ?? []) as GroupOpt[]);
      setLoading(false);
    })();
  }, []);

  const filteredCreds = useMemo(() => {
    const q = credQuery.trim().toLowerCase();
    if (!q) return creds;
    return creds.filter((c) => [c.platform_name, c.category].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [creds, credQuery]);

  const filteredEmps = useMemo(() => {
    const q = empQuery.trim().toLowerCase();
    if (!q) return emps;
    return emps.filter((e) => [e.full_name, e.work_email, e.designation].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [emps, empQuery]);

  const filteredGroups = useMemo(() => {
    const q = groupQuery.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => (g.display_name ?? '').toLowerCase().includes(q));
  }, [groups, groupQuery]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const submit = async () => {
    if (selCreds.size === 0) { setMsg({ kind: 'err', text: 'Pick at least one credential' }); return; }
    if (selEmps.size === 0 && selGroups.size === 0) { setMsg({ kind: 'err', text: 'Pick at least one employee or group' }); return; }
    setBusy(true); setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cred-grant-access`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential_ids: Array.from(selCreds),
          employee_ids: Array.from(selEmps),
          group_ids: Array.from(selGroups),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setMsg({ kind: 'ok', text: `Granted access: ${j.inserted} new record${j.inserted === 1 ? '' : 's'}.` });
      await onDone();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b border-dark-700 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg text-white font-semibold">Grant credential access</h2>
            <p className="text-[11px] text-gray-500">Select credentials + employees or groups. Saves access records without sending emails.</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white">✕</button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Credentials picker */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs uppercase tracking-wider text-gray-500">Credentials ({selCreds.size} selected)</p>
              <input
                value={credQuery} onChange={(e) => setCredQuery(e.target.value)}
                placeholder="Search vault…"
                className="px-2 py-1 rounded-md text-xs bg-dark-900 border border-dark-700 text-white placeholder-gray-600 focus:outline-none w-48"
              />
            </div>
            <div className="max-h-44 overflow-y-auto bg-dark-900/60 rounded-lg border border-dark-700 divide-y divide-dark-700/40">
              {loading ? (
                <p className="px-3 py-4 text-center text-xs text-gray-500">Loading…</p>
              ) : filteredCreds.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-gray-500">No credentials match.</p>
              ) : filteredCreds.map((c) => (
                <label key={c.id} className="flex items-center gap-3 px-3 py-2 hover:bg-dark-800/40 cursor-pointer">
                  <input type="checkbox" checked={selCreds.has(c.id)} onChange={() => toggle(selCreds, setSelCreds, c.id)} />
                  <span className="text-xs text-white flex-1 truncate">{c.platform_name}</span>
                  {c.category && <span className="text-[10px] text-gray-500">{c.category}</span>}
                </label>
              ))}
            </div>
          </section>

          {/* Recipients picker — tabs */}
          <section>
            <div className="flex items-center gap-1 mb-2 border-b border-dark-700">
              <button onClick={() => setTab('employees')}
                className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${tab === 'employees' ? 'border-emerald-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
                Employees ({selEmps.size})
              </button>
              <button onClick={() => setTab('groups')}
                className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${tab === 'groups' ? 'border-emerald-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
                Groups ({selGroups.size})
              </button>
              <div className="flex-1" />
              <input
                value={tab === 'employees' ? empQuery : groupQuery}
                onChange={(e) => tab === 'employees' ? setEmpQuery(e.target.value) : setGroupQuery(e.target.value)}
                placeholder={tab === 'employees' ? 'Search employees…' : 'Search groups…'}
                className="px-2 py-1 mb-1 rounded-md text-xs bg-dark-900 border border-dark-700 text-white placeholder-gray-600 focus:outline-none w-48"
              />
            </div>

            {tab === 'employees' ? (
              <div className="max-h-56 overflow-y-auto bg-dark-900/60 rounded-lg border border-dark-700 divide-y divide-dark-700/40">
                {filteredEmps.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-gray-500">No employees match.</p>
                ) : filteredEmps.map((e) => (
                  <label key={e.id} className="flex items-center gap-3 px-3 py-2 hover:bg-dark-800/40 cursor-pointer">
                    <input type="checkbox" checked={selEmps.has(e.id)} onChange={() => toggle(selEmps, setSelEmps, e.id)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{e.full_name}</p>
                      <p className="text-[10px] text-gray-500 truncate">{e.work_email ?? '—'}{e.designation ? ` · ${e.designation}` : ''}</p>
                    </div>
                  </label>
                ))}
              </div>
            ) : (
              <div className="max-h-56 overflow-y-auto bg-dark-900/60 rounded-lg border border-dark-700 divide-y divide-dark-700/40">
                {filteredGroups.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-gray-500">No groups synced yet. Connect Microsoft 365 / Google Workspace first.</p>
                ) : filteredGroups.map((g) => (
                  <label key={g.id} className="flex items-center gap-3 px-3 py-2 hover:bg-dark-800/40 cursor-pointer">
                    <input type="checkbox" checked={selGroups.has(g.id)} onChange={() => toggle(selGroups, setSelGroups, g.id)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{g.display_name ?? '—'}</p>
                      <p className="text-[10px] text-gray-500 truncate">{g.provider} · {g.members_count} member{g.members_count === 1 ? '' : 's'}</p>
                    </div>
                  </label>
                ))}
                <p className="px-3 py-2 text-[10px] text-cyan-300 bg-cyan-500/5">
                  ℹ Selecting a group auto-expands to its members on save. Directory-only users (M365 / Google) that don't yet have an employees row get auto-provisioned at grant time — no manual onboarding required first.
                </p>
              </div>
            )}
          </section>

          {msg && (
            <div className={`px-3 py-2 rounded-lg text-xs border ${
              msg.kind === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            }`}>{msg.text}</div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-dark-700 flex items-center justify-between gap-2 flex-shrink-0">
          <p className="text-[11px] text-gray-500">
            Will create up to {selCreds.size * (selEmps.size + (selGroups.size > 0 ? '?' : 0).toString().length)} access records. Existing assignments are skipped.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
            <button onClick={submit} disabled={busy}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
              {busy ? 'Granting…' : 'Grant access'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
