import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

type Offboarding = {
  id: string;
  org_id: string;
  employee_id: string;
  initiated_at: string;
  reason: string | null;
  lwd: string | null;
  current_stage: 'creds_review' | 'access_revoked' | 'devices_pending' | 'completed';
  status: 'in_progress' | 'cancelled' | 'done';
  stage1_it_recipients: string[];
  laptop_serial: string | null;
  asset_notes: string | null;
  it_remark: string | null;
};
type Employee = { id: string; full_name: string; work_email: string | null; status: string; designation?: string | null; doj?: string | null; lwd?: string | null };
type CredHist = { platform_name: string; username: string | null; sent_at: string };

const STAGE_LABEL = {
  creds_review: 'Stage 1: Creds review',
  access_revoked: 'Stage 2: Revoke credentials',
  devices_pending: 'Stage 3: Device handover',
  completed: 'Stage 4: Completed',
} as const;

export default function OffboardingPipeline() {
  const [items, setItems] = useState<Offboarding[]>([]);
  const [allItems, setAllItems] = useState<Offboarding[]>([]);
  const [emps, setEmps] = useState<Record<string, Employee>>({});
  const [loading, setLoading] = useState(true);
  const [startFor, setStartFor] = useState<Employee | null>(null);
  const [active, setActive] = useState<Offboarding | null>(null);
  const [activeHist, setActiveHist] = useState<CredHist[]>([]);
  const [activeEmployees, setActiveEmployees] = useState<Employee[]>([]);
  const [tab, setTab] = useState<'pipeline' | 'history' | 'dashboard'>('pipeline');
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyYear, setHistoryYear] = useState<string>('all');

  const load = useCallback(async () => {
    setLoading(true);
    // Fetch ALL offboardings (in-progress + done + cancelled) so the History
    // tab can show completed records too. Active pipeline view filters
    // client-side.
    const [{ data: o }, { data: e }] = await Promise.all([
      supabase.from('offboardings').select('*').range(0, 9999).order('initiated_at', { ascending: false }),
      supabase.from('employees').select('id, full_name, work_email, status, designation, doj, lwd').range(0, 9999),
    ]);
    const allOffs = (o ?? []) as Offboarding[];
    setAllItems(allOffs);
    setItems(allOffs.filter((x) => x.status === 'in_progress'));
    const map: Record<string, Employee> = {};
    for (const x of (e ?? []) as Employee[]) map[x.id] = x;
    setEmps(map);
    setActiveEmployees(((e ?? []) as Employee[]).filter((x) => x.status === 'active'));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => ({
    creds_review:    items.filter((x) => x.current_stage === 'creds_review'),
    access_revoked:  items.filter((x) => x.current_stage === 'access_revoked'),
    devices_pending: items.filter((x) => x.current_stage === 'devices_pending'),
    completed:       items.filter((x) => x.current_stage === 'completed'),
  }), [items]);

  const openOff = async (off: Offboarding) => {
    setActive(off);
    const { data } = await supabase
      .from('v_employee_cred_history')
      .select('platform_name, username, sent_at')
      .eq('employee_id', off.employee_id)
      .order('sent_at', { ascending: false });
    setActiveHist((data ?? []) as CredHist[]);
  };

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
          <div>
            <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">Offboarding pipeline</h1>
            <p className="text-sm text-gray-400">Three stages: creds review → access revoked → laptop handover & complete.</p>
          </div>
          <button onClick={() => setStartFor({ id: '', full_name: '', work_email: '', status: 'active' })}
            className="px-3 py-2 bg-rose-600 hover:bg-rose-500 rounded-lg text-sm text-white font-medium">
            <i className="ri-logout-box-line mr-1" /> Move employee to offboarding
          </button>
        </header>

        <DefaultRecipientsCard />

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-4 border-b border-dark-700">
          {([
            { id: 'pipeline',  label: 'Active pipeline', icon: 'ri-flow-chart' },
            { id: 'history',   label: 'History',         icon: 'ri-archive-line' },
            { id: 'dashboard', label: 'Dashboard',       icon: 'ri-bar-chart-line' },
          ] as const).map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm flex items-center gap-1.5 border-b-2 transition-colors ${
                tab === t.id ? 'border-emerald-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}>
              <i className={t.icon} />
              {t.label}
              {t.id === 'history' && <span className="ml-1 text-[10px] text-gray-500">({allItems.filter((x) => x.status === 'done').length})</span>}
            </button>
          ))}
        </div>

        {tab === 'pipeline' && (loading ? <p className="text-sm text-gray-500">Loading…</p> : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {(['creds_review', 'access_revoked', 'devices_pending', 'completed'] as const).map((stage) => (
              <section key={stage} className="bg-dark-800 border border-dark-700 rounded-xl flex flex-col min-h-[200px]">
                <header className="px-4 py-3 border-b border-dark-700 flex items-center justify-between">
                  <h2 className="text-sm text-white font-medium">{STAGE_LABEL[stage]}</h2>
                  <span className="text-xs text-gray-500">{grouped[stage].length}</span>
                </header>
                <div className="p-3 space-y-2 flex-1">
                  {grouped[stage].length === 0 ? (
                    <p className="text-xs text-gray-500 text-center py-6">None</p>
                  ) : grouped[stage].map((o) => {
                    const e = emps[o.employee_id];
                    return (
                      <button key={o.id} onClick={() => openOff(o)}
                        className="w-full text-left p-3 bg-dark-900/60 hover:bg-dark-900 border border-dark-700 rounded-lg transition-colors">
                        <p className="text-sm text-white font-medium truncate">{e?.full_name ?? o.employee_id}</p>
                        <p className="text-xs text-gray-500 truncate">{e?.work_email ?? '—'}</p>
                        <p className="text-[11px] text-gray-500 mt-1">Started {new Date(o.initiated_at).toLocaleDateString()}{o.lwd && ` · LWD ${o.lwd}`}</p>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ))}

        {tab === 'history' && (
          <HistoryView
            items={allItems.filter((x) => x.status === 'done' || x.status === 'cancelled')}
            employees={emps}
            query={historyQuery}
            setQuery={setHistoryQuery}
            year={historyYear}
            setYear={setHistoryYear}
            onOpen={openOff}
          />
        )}

        {tab === 'dashboard' && (
          <DashboardView items={allItems} employees={emps} />
        )}

        <div className="mt-6">
          <Link to="/employees" className="text-xs text-emerald-400 hover:text-emerald-300">← Back to employees</Link>
        </div>
      </div>

      {startFor && (
        <StartModal
          employees={activeEmployees}
          onClose={() => setStartFor(null)}
          onDone={async () => { setStartFor(null); await load(); }}
        />
      )}
      {active && (
        <OffboardingDrawer
          off={active} employee={emps[active.employee_id]} hist={activeHist}
          onClose={() => setActive(null)}
          onChanged={async () => { await load(); setActive(null); }}
        />
      )}
    </DashboardLayout>
  );
}

// ============== default recipients card ==============
// Lets each customer set their own IT / HR / Accounts mailing lists once.
// These defaults pre-fill every offboarding modal so the IT user doesn't have
// to retype them. Persisted via `org-settings-save` edge function so RLS
// + audit log are consistent with the credentials page.

function DefaultRecipientsCard() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [it, setIt] = useState('');
  const [hr, setHr] = useState('');
  const [acc, setAcc] = useState('');
  const [saved, setSaved] = useState({ it: '', hr: '', acc: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Scope org read to the caller's actual org — super-admins see all orgs
  // via RLS and would otherwise get arbitrary tenant defaults pre-filled.
  // See feedback-super-admin-rls-limit-pitfall memory note.
  const { organization } = useAuth();
  const orgId = organization?.id ?? null;

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const { data } = await supabase
        .from('organizations')
        .select('it_recipient_emails, hr_recipient_emails, accounts_recipient_emails')
        .eq('id', orgId)
        .maybeSingle();
      const row = data as {
        it_recipient_emails: string[];
        hr_recipient_emails: string[];
        accounts_recipient_emails: string[];
      } | null;
      const itStr = (row?.it_recipient_emails ?? []).join(', ');
      const hrStr = (row?.hr_recipient_emails ?? []).join(', ');
      const accStr = (row?.accounts_recipient_emails ?? []).join(', ');
      setIt(itStr); setHr(hrStr); setAcc(accStr);
      setSaved({ it: itStr, hr: hrStr, acc: accStr });
      setLoading(false);
    })();
  }, [orgId]);

  const dirty = it !== saved.it || hr !== saved.hr || acc !== saved.acc;

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const splitEmails = (v: string) => v.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/org-settings-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          it_recipient_emails: splitEmails(it),
          hr_recipient_emails: splitEmails(hr),
          accounts_recipient_emails: splitEmails(acc),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSaved({ it, hr, acc });
      setMsg({ kind: 'ok', text: 'Defaults saved. New offboardings will use these recipients automatically.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const summary = [
    saved.it && `IT: ${saved.it.split(',')[0]}${saved.it.includes(',') ? ` +${saved.it.split(',').length - 1}` : ''}`,
    saved.hr && `HR: ${saved.hr.split(',')[0]}${saved.hr.includes(',') ? ` +${saved.hr.split(',').length - 1}` : ''}`,
    saved.acc && `Accounts: ${saved.acc.split(',')[0]}${saved.acc.includes(',') ? ` +${saved.acc.split(',').length - 1}` : ''}`,
  ].filter(Boolean).join(' · ') || 'Not set — using Wellness Extract default fallback';

  return (
    <section className="mb-5 bg-dark-800/50 border border-dark-700 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-dark-800 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-cyan-500/15 text-cyan-400 flex items-center justify-center shrink-0">
            <i className="ri-mail-settings-line" />
          </span>
          <div className="min-w-0">
            <p className="text-sm text-white font-medium">Default offboarding recipients</p>
            <p className="text-[11px] text-gray-500 truncate">{loading ? 'Loading…' : summary}</p>
          </div>
        </div>
        <i className={`ri-arrow-${open ? 'up' : 'down'}-s-line text-gray-500`} />
      </button>

      {open && (
        <div className="px-4 pb-4 pt-2 border-t border-dark-700 space-y-3">
          <p className="text-[11px] text-gray-500 max-w-2xl">
            These mailing lists pre-fill every offboarding's email step so your IT user doesn't have to retype them.
            You can still override per-offboarding in the modal.
          </p>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">IT recipients (creds reclaim emails)</label>
            <textarea
              value={it} onChange={(e) => setIt(e.target.value)}
              placeholder="it@yourcompany.com, infra@yourcompany.com"
              className={`${inputCls} h-16 resize-none`}
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">HR recipients (offboarding summary)</label>
            <textarea
              value={hr} onChange={(e) => setHr(e.target.value)}
              placeholder="hr@yourcompany.com"
              className={`${inputCls} h-16 resize-none`}
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Accounts recipients (FNF / payroll close)</label>
            <textarea
              value={acc} onChange={(e) => setAcc(e.target.value)}
              placeholder="accounts@yourcompany.com, payroll@yourcompany.com"
              className={`${inputCls} h-16 resize-none`}
            />
          </div>
          {msg && (
            <div className={`px-3 py-2 rounded-lg text-xs border ${
              msg.kind === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            }`}>{msg.text}</div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={save} disabled={busy || !dirty}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium"
            >
              {busy ? 'Saving…' : 'Save defaults'}
            </button>
            {!dirty && saved.it && <span className="text-[11px] text-emerald-300">Saved · used as defaults below</span>}
          </div>
        </div>
      )}
    </section>
  );
}

// ============== history view ==============
// Lists every completed (or cancelled) offboarding the org has done. Each
// row → click → opens the same drawer used for live pipeline cards, so all
// the details (creds revoked, devices reclaimed, IT remark, recipients) are
// available read-style after the fact.

function HistoryView({
  items, employees, query, setQuery, year, setYear, onOpen,
}: {
  items: Offboarding[];
  employees: Record<string, Employee>;
  query: string;
  setQuery: (v: string) => void;
  year: string;
  setYear: (v: string) => void;
  onOpen: (o: Offboarding) => void;
}) {
  // Year picker — only the years we actually have records for.
  const years = useMemo(() => {
    const s = new Set<string>();
    for (const o of items) s.add(new Date(o.initiated_at).getFullYear().toString());
    return Array.from(s).sort((a, b) => Number(b) - Number(a));
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((o) => {
      if (year !== 'all' && new Date(o.initiated_at).getFullYear().toString() !== year) return false;
      if (!q) return true;
      const e = employees[o.employee_id];
      return [e?.full_name, e?.work_email, e?.designation, o.reason, o.it_remark]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [items, employees, query, year]);

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-dark-700 flex items-center gap-3 flex-wrap">
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, email, designation, reason…"
          className="flex-1 min-w-[200px] px-3 py-2 rounded-lg bg-dark-900 border border-dark-700 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/50"
        />
        <select value={year} onChange={(e) => setYear(e.target.value)}
          className="px-3 py-2 rounded-lg bg-dark-900 border border-dark-700 text-sm text-white">
          <option value="all">All years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-gray-500">
          No offboarding records {year !== 'all' ? `for ${year}` : 'yet'}.
        </p>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Employee</th>
              <th className="px-4 py-3 text-left">Designation</th>
              <th className="px-4 py-3 text-left">Joined</th>
              <th className="px-4 py-3 text-left">Exit</th>
              <th className="px-4 py-3 text-left">Reason</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700/60">
            {filtered.map((o) => {
              const e = employees[o.employee_id];
              return (
                <tr key={o.id} className="hover:bg-dark-700/30">
                  <td className="px-4 py-3">
                    <p className="text-sm text-white">{e?.full_name ?? '—'}</p>
                    <p className="text-[11px] text-gray-500">{e?.work_email ?? '—'}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-300 text-xs">{e?.designation ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-[11px]">
                    {e?.doj ? new Date(e.doj).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                  </td>
                  <td className="px-4 py-3 text-rose-300 text-[11px]">
                    {e?.lwd ? new Date(e.lwd).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
                      : o.lwd ? new Date(o.lwd).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs truncate max-w-[200px]">{o.reason ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wider border ${
                      o.status === 'done'
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                        : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    }`}>{o.status === 'done' ? 'Completed' : 'Cancelled'}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => onOpen(o)}
                      className="px-2.5 py-1 text-[11px] rounded-md bg-dark-700 hover:bg-dark-600 text-gray-300">
                      View
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

// ============== dashboard view ==============
// Monthly + yearly aggregations + top reasons + average stage durations.
// Pure client-side aggregation off the offboardings we already loaded.

function DashboardView({
  items, employees,
}: {
  items: Offboarding[];
  employees: Record<string, Employee>;
}) {
  const [yearFilter, setYearFilter] = useState<string>(new Date().getFullYear().toString());

  const years = useMemo(() => {
    const s = new Set<string>();
    for (const o of items) s.add(new Date(o.initiated_at).getFullYear().toString());
    return Array.from(s).sort((a, b) => Number(b) - Number(a));
  }, [items]);

  const yearItems = useMemo(
    () => items.filter((o) => new Date(o.initiated_at).getFullYear().toString() === yearFilter),
    [items, yearFilter],
  );

  // Monthly counts within the selected year.
  const monthly = useMemo(() => {
    const buckets = new Array(12).fill(0);
    for (const o of yearItems) buckets[new Date(o.initiated_at).getMonth()]++;
    return buckets;
  }, [yearItems]);
  const maxMonth = Math.max(1, ...monthly);

  // Top reasons (textual).
  const reasonCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of yearItems) {
      const r = (o.reason ?? '').trim() || 'Not specified';
      m.set(r, (m.get(r) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [yearItems]);

  // Status split.
  const statusSplit = useMemo(() => {
    const m = { in_progress: 0, done: 0, cancelled: 0 };
    for (const o of yearItems) {
      if (o.status === 'in_progress') m.in_progress++;
      else if (o.status === 'done') m.done++;
      else m.cancelled++;
    }
    return m;
  }, [yearItems]);

  // Avg days from initiated → completed.
  const avgDays = useMemo(() => {
    const completed = yearItems.filter((o) => o.status === 'done');
    if (completed.length === 0) return null;
    const empMap = employees;
    let total = 0, count = 0;
    for (const o of completed) {
      const e = empMap[o.employee_id];
      const finishedAt = e?.lwd ? new Date(e.lwd).getTime() : null;
      if (!finishedAt) continue;
      const startMs = new Date(o.initiated_at).getTime();
      const days = (finishedAt - startMs) / 86400000;
      if (days >= 0 && days < 365) { total += days; count++; }
    }
    return count === 0 ? null : Math.round(total / count);
  }, [yearItems, employees]);

  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  return (
    <div className="space-y-4">
      {/* Year picker */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-base font-semibold text-white">Offboarding analytics</h2>
        <select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)}
          className="px-3 py-2 rounded-lg bg-dark-900 border border-dark-700 text-sm text-white">
          {years.length === 0 && <option value={yearFilter}>{yearFilter}</option>}
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Total this year" value={yearItems.length} tint="text-white" />
        <Kpi label="Completed" value={statusSplit.done} tint="text-emerald-300" />
        <Kpi label="In progress" value={statusSplit.in_progress} tint="text-amber-300" />
        <Kpi label="Avg days to close" value={avgDays != null ? `${avgDays}d` : '—'} tint="text-cyan-300" />
      </div>

      {/* Monthly bar chart */}
      <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white">Monthly trend · {yearFilter}</h3>
          <p className="text-[11px] text-gray-500">Initiated by month</p>
        </div>
        <div className="grid grid-cols-12 gap-2 items-end h-40">
          {monthly.map((n, i) => (
            <div key={i} className="flex flex-col items-center gap-1 h-full">
              <div className="w-full flex-1 flex items-end">
                <div
                  className={`w-full rounded-t ${n > 0 ? 'bg-emerald-500/50' : 'bg-dark-700'}`}
                  style={{ height: `${(n / maxMonth) * 100}%` }}
                  title={`${monthLabels[i]} ${yearFilter}: ${n}`}
                />
              </div>
              <span className="text-[10px] text-gray-500">{monthLabels[i]}</span>
              <span className="text-[11px] text-white font-medium">{n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Top reasons */}
      <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Top reasons · {yearFilter}</h3>
        {reasonCounts.length === 0 ? (
          <p className="text-xs text-gray-500">No data for {yearFilter}.</p>
        ) : (
          <div className="space-y-2">
            {reasonCounts.map(([reason, count]) => {
              const pct = (count / yearItems.length) * 100;
              return (
                <div key={reason}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-300 truncate">{reason}</span>
                    <span className="text-gray-500">{count} · {pct.toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-dark-900">
                    <div className="h-full rounded-full bg-rose-500/60" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, tint }: { label: string; value: number | string; tint: string }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`text-2xl font-poppins font-bold mt-1 ${tint}`}>{value}</p>
    </div>
  );
}

// ============== start modal ==============

function StartModal({
  employees, onClose, onDone,
}: {
  employees: Employee[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [empId, setEmpId] = useState('');
  const [reason, setReason] = useState('');
  const [lwd, setLwd] = useState('');
  const [itEmails, setItEmails] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { organization } = useAuth();
  const orgId = organization?.id ?? null;

  // Pre-fill IT recipients from the org-wide default. Filter by orgId
  // (not `.limit(1)`) so super-admins don't get another tenant's defaults.
  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const { data } = await supabase
        .from('organizations')
        .select('it_recipient_emails')
        .eq('id', orgId)
        .maybeSingle();
      const emails = ((data as { it_recipient_emails: string[] } | null)?.it_recipient_emails ?? []);
      if (emails.length > 0) setItEmails(emails.join(', '));
    })();
  }, [orgId]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const recipients = itEmails.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
      if (!recipients.length) throw new Error('At least one IT recipient email required');
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/offboarding`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', employee_id: empId, reason: reason || undefined, lwd: lwd || undefined, it_recipients: recipients }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Start offboarding" onClose={onClose} footer={
      <>
        <button onClick={onClose} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</button>
        <button onClick={submit} disabled={!empId || busy} className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
          {busy ? 'Sending IT mail…' : 'Start & email IT'}
        </button>
      </>
    }>
      {err && <Err msg={err} />}
      <Field label="Employee *">
        <select value={empId} onChange={(e) => setEmpId(e.target.value)} className={inputCls}>
          <option value="">— pick employee —</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name} {e.work_email ? `· ${e.work_email}` : ''}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Last working day"><input type="date" value={lwd} onChange={(e) => setLwd(e.target.value)} className={inputCls} /></Field>
        <Field label="Reason (internal)"><input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder="Resignation" /></Field>
      </div>
      <Field label="IT recipient emails *">
        <textarea value={itEmails} onChange={(e) => setItEmails(e.target.value)} className={`${inputCls} h-20 resize-none`}
          placeholder="it@company.com, infra@company.com" />
      </Field>
      <p className="text-xs text-gray-500">First email becomes TO, the rest CC. They receive the complete list of creds dispatched to this employee.</p>
    </Modal>
  );
}

// ============== drawer (current stage actions) ==============

function OffboardingDrawer({
  off, employee, hist, onClose, onChanged,
}: {
  off: Offboarding;
  employee: Employee | undefined;
  hist: CredHist[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { organization } = useAuth();
  const drawerOrgId = organization?.id ?? null;

  const [laptopSerial, setLaptopSerial] = useState(off.laptop_serial ?? '');
  const [assetNotes, setAssetNotes] = useState(off.asset_notes ?? '');
  const [itRemark, setItRemark] = useState(off.it_remark ?? '');
  const [hrEmails, setHrEmails] = useState('');
  const [accEmails, setAccEmails] = useState('');

  // Credentials currently assigned (not yet revoked) to this employee — IT
  // marks each one as revoked during stage 2/3, and on Complete we persist
  // revoked_at on credential_assignments. This becomes the audit trail for
  // the NOC that's mailed out at the end.
  type CredAssignment = {
    id: string;
    credential_id: string;
    sent_at: string;
    revoked_at: string | null;
    platform_name?: string | null;
  };
  const [credAssignments, setCredAssignments] = useState<CredAssignment[]>([]);
  const [revokedIds, setRevokedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!employee?.id) return;
    (async () => {
      const { data } = await supabase
        .from('credential_assignments')
        .select('id, credential_id, sent_at, revoked_at, credentials_safe(platform_name)')
        .eq('employee_id', employee.id)
        .is('revoked_at', null)
        .order('sent_at', { ascending: false });
      type Row = CredAssignment & { credentials_safe: { platform_name: string } | null };
      const rows = ((data ?? []) as Row[]).map((r) => ({
        ...r,
        platform_name: r.credentials_safe?.platform_name ?? null,
      }));
      setCredAssignments(rows);
    })();
  }, [employee?.id]);

  // Devices currently assigned to this employee — auto-fetched so IT doesn't
  // have to remember/type each laptop, monitor, phone serial. Pre-populates
  // laptop_serial + asset_notes with the full list so the offboarding email
  // shows everything that needs to be reclaimed.
  type AssignedDevice = {
    id: string; device_serial: string; device_tag: string | null; device_type: string;
    brand: string | null; model: string | null; configuration: string | null;
  };
  const [assignedDevices, setAssignedDevices] = useState<AssignedDevice[]>([]);
  useEffect(() => {
    if (!employee?.id) return;
    (async () => {
      const { data } = await supabase
        .from('hardware_assets')
        .select('id, device_serial, device_tag, device_type, brand, model, configuration')
        .eq('assigned_employee_id', employee.id)
        .eq('status', 'assigned');
      const list = (data ?? []) as AssignedDevice[];
      setAssignedDevices(list);
      // Pre-fill laptop_serial + asset_notes only if the user hasn't typed
      // something custom yet.
      if (list.length > 0) {
        const serials = list.map((d) => d.device_tag ? `${d.device_tag} (${d.device_serial})` : d.device_serial).join(', ');
        const summary = list.map((d) => {
          const parts = [d.brand, d.model, d.configuration].filter(Boolean).join(' ');
          const tag = d.device_tag || d.device_serial;
          return `${d.device_type}: ${tag}${parts ? ` — ${parts}` : ''}`;
        }).join('\n');
        setLaptopSerial((cur) => cur || serials);
        setAssetNotes((cur) => cur || summary);
      }
    })();
  }, [employee?.id]);

  // Pre-fill HR + Accounts recipients from the org-wide defaults so the
  // customer doesn't have to retype them on every offboarding. Filter by
  // orgId — super-admins see all orgs via RLS otherwise. See
  // feedback-super-admin-rls-limit-pitfall memory.
  useEffect(() => {
    if (!drawerOrgId) return;
    (async () => {
      const { data } = await supabase
        .from('organizations')
        .select('hr_recipient_emails, accounts_recipient_emails')
        .eq('id', drawerOrgId)
        .maybeSingle();
      const row = data as { hr_recipient_emails: string[]; accounts_recipient_emails: string[] } | null;
      if (row?.hr_recipient_emails?.length) setHrEmails(row.hr_recipient_emails.join(', '));
      if (row?.accounts_recipient_emails?.length) setAccEmails(row.accounts_recipient_emails.join(', '));
    })();
  }, [drawerOrgId]);

  const call = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/offboarding`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ offboarding_id: off.id, ...body }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
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
            <p className="text-xs text-gray-500 uppercase tracking-wider">{STAGE_LABEL[off.current_stage]}</p>
            <h2 className="text-lg text-white font-semibold truncate">{employee?.full_name ?? off.employee_id}</h2>
            <p className="text-xs text-gray-500 truncate">{employee?.work_email ?? '—'}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>

        <div className="p-5 space-y-5">
          {err && <Err msg={err} />}

          {/* Read-only credential summary — shown on every stage so IT can
              always see what's been dispatched. The interactive revoke
              checklist appears only in Stage 3 (devices_pending) below. */}
          {off.current_stage !== 'devices_pending' && (
            <section>
              <h3 className="text-sm text-white font-medium mb-2">Credentials dispatched ({hist.length})</h3>
              {hist.length === 0 ? (
                <p className="text-xs text-gray-500 px-3 py-3 bg-dark-900/60 rounded-lg">None recorded.</p>
              ) : (
                <div className="max-h-32 overflow-y-auto bg-dark-900/60 rounded-lg">
                  {hist.map((h, i) => (
                    <div key={i} className="px-3 py-1.5 border-b border-dark-700/40 last:border-0">
                      <p className="text-[11px] text-white">{h.platform_name}</p>
                      <p className="text-[10px] text-gray-500">{h.username ?? '—'} · {new Date(h.sent_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {off.current_stage === 'creds_review' && (
            <section className="space-y-3">
              <p className="text-xs text-gray-400">Stage 1 complete: IT team has received the creds list. When ready, revoke access on M365/Google.</p>
              <button disabled={busy} onClick={() => call({ action: 'revoke' })}
                className="w-full px-4 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
                {busy ? 'Revoking…' : 'IT verified — Revoke sign-in now'}
              </button>
            </section>
          )}

          {off.current_stage === 'access_revoked' && (
            <section className="space-y-3">
              <div className="px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                <p className="text-[11px] text-emerald-300">
                  ✓ Microsoft 365 / Google sign-in has been revoked. The employee can no longer log into directory-managed apps.
                </p>
              </div>
              <p className="text-xs text-gray-400">
                Next: in Stage 3 we'll mark each per-app credential as revoked, collect the laptop, record your IT remark, and only then issue the NOC to HR + Accounts. <strong>No emails go out at this step.</strong>
              </p>
              <button disabled={busy} onClick={() => call({ action: 'advance_to_devices' })}
                className="w-full px-4 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
                {busy ? 'Advancing…' : 'Advance to Stage 3 → device handover'}
              </button>
            </section>
          )}

          {off.current_stage === 'devices_pending' && (
            <section className="space-y-3">
              <p className="text-xs text-gray-400">
                Final step: mark each app credential as revoked, record any devices collected, add your IT remark, and issue the NOC. The HR + Accounts email goes out on Complete.
              </p>

              {/* Interactive credentials checklist — IT marks each as revoked.
                  Marked rows are persisted on Complete via revoked_credential_ids. */}
              <div>
                <h4 className="text-xs uppercase tracking-wider text-gray-500 mb-1.5">
                  Credentials to revoke
                  {credAssignments.length > 0 && (
                    <span className="ml-2 text-gray-400 normal-case">({revokedIds.size} / {credAssignments.length} marked)</span>
                  )}
                </h4>
                {credAssignments.length > 0 ? (
                  <>
                    <div className="max-h-56 overflow-y-auto bg-dark-900/60 rounded-lg divide-y divide-dark-700/40 border border-dark-700">
                      {credAssignments.map((c) => {
                        const isRevoked = revokedIds.has(c.id);
                        return (
                          <label key={c.id} className="flex items-center gap-3 px-3 py-2 hover:bg-dark-800/40 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isRevoked}
                              onChange={() => setRevokedIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                                return next;
                              })}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-white truncate">{c.platform_name ?? '—'}</p>
                              <p className="text-[10px] text-gray-500">Sent {new Date(c.sent_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</p>
                            </div>
                            {isRevoked && <span className="text-[10px] text-rose-300">Will revoke</span>}
                          </label>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={() => setRevokedIds(new Set(credAssignments.map((c) => c.id)))}
                      className="mt-1.5 text-[11px] text-cyan-400 hover:text-cyan-300"
                    >
                      Select all to revoke
                    </button>
                  </>
                ) : (
                  <p className="text-xs text-gray-500 px-3 py-3 bg-dark-900/60 rounded-lg border border-dark-700">All credentials already revoked (or none dispatched).</p>
                )}
              </div>

              {/* Auto-pulled list of every device currently assigned to this
                  employee. Includes laptop, monitor, phone, etc. — multiple
                  devices per employee are supported. */}
              {assignedDevices.length > 0 ? (
                <div className="px-3 py-2.5 rounded-lg bg-cyan-500/5 border border-cyan-500/25">
                  <p className="text-[10px] uppercase tracking-wider text-cyan-300 mb-1.5">
                    {assignedDevices.length} device{assignedDevices.length === 1 ? '' : 's'} assigned — auto-reclaim on completion
                  </p>
                  <ul className="space-y-1">
                    {assignedDevices.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-white truncate">
                          {d.device_tag || d.device_serial}
                          <span className="text-gray-500 ml-2 capitalize">{d.device_type}</span>
                        </span>
                        <span className="text-gray-400 text-[11px] truncate">
                          {[d.brand, d.model].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[10px] text-cyan-200/60 mt-1.5">
                    Completing offboarding auto-unassigns these devices and stamps the employee's exit date.
                  </p>
                </div>
              ) : (
                <div className="px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/25 text-[11px] text-amber-300">
                  No devices currently assigned to this employee in IT Hardware inventory.
                </div>
              )}

              <Field label="Laptop serial (auto-filled)"><input value={laptopSerial} onChange={(e) => setLaptopSerial(e.target.value)} className={inputCls} placeholder="C02XX1234567" /></Field>
              <Field label="Asset notes (auto-filled)"><textarea value={assetNotes} onChange={(e) => setAssetNotes(e.target.value)} className={`${inputCls} h-20 resize-none font-mono`} placeholder="Charger + bag returned" /></Field>
              <Field label="IT remark"><textarea value={itRemark} onChange={(e) => setItRemark(e.target.value)} className={`${inputCls} h-16 resize-none`} placeholder="Wiped, signed off" /></Field>
              <Field label="HR recipient emails"><textarea value={hrEmails} onChange={(e) => setHrEmails(e.target.value)} className={`${inputCls} h-14 resize-none`} placeholder="hr@company.com" /></Field>
              <Field label="Accounts recipient emails"><textarea value={accEmails} onChange={(e) => setAccEmails(e.target.value)} className={`${inputCls} h-14 resize-none`} placeholder="accounts@company.com" /></Field>
              <button disabled={busy || !itRemark.trim()} onClick={() => call({
                action: 'complete',
                laptop_serial: laptopSerial || undefined,
                asset_notes: assetNotes || undefined,
                it_remark: itRemark || undefined,
                hr_recipients: hrEmails.split(/[,\s]+/).filter((x) => x.includes('@')),
                accounts_recipients: accEmails.split(/[,\s]+/).filter((x) => x.includes('@')),
                revoked_credential_ids: Array.from(revokedIds),
              })} className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
                {busy ? 'Finalizing…' : 'Complete · revoke creds · email HR + Accounts + issue NOC'}
              </button>
              {!itRemark.trim() && (
                <p className="text-[11px] text-amber-300">⚠ IT remark is required before issuing NOC.</p>
              )}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

const inputCls = "w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-xs text-gray-400 mb-1">{label}</span>{children}</label>;
}
function Err({ msg }: { msg: string }) {
  return <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{msg}</div>;
}
function Modal({ title, onClose, footer, children }: { title: string; onClose: () => void; footer: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
          <h2 className="text-lg text-white font-semibold">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400"><i className="ri-close-line" /></button>
        </header>
        <div className="p-5 space-y-3">{children}</div>
        <footer className="px-5 py-3 border-t border-dark-700 flex justify-end gap-2">{footer}</footer>
      </div>
    </div>
  );
}
