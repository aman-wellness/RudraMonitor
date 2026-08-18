// Microsoft 365 "Add a user" wizard.
//
// Steps mirror the Microsoft admin center flow (see screenshots from product):
//   1. Basics            — name, display name, username @ domain, password mode
//   2. Product licenses  — usage location + license SKU checklist
//   3. Review            — full summary
//   4. Finish            — success screen with Show password
//
// All M365-side fields go straight into Microsoft Graph via provision-employee.
// Rudrans-side metadata (department, manager, DOJ, employee code, personal email)
// is collected on the Optional step before review.

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
// `country-state-city` is ~8 MB unpacked. Defer it to a separate chunk
// loaded only when this M365 form is actually navigated to.
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';

interface Domain { name: string; isDefault: boolean }
interface Sku {
  sku_id: string;
  sku_part_number: string;
  consumed: number;
  enabled: number;
  available: number;
  display_name: string;
}
interface TenantInfo { verified_domains: Domain[]; subscribed_skus: Sku[] }

type Department = { id: string; name: string };
type EmployeeLite = { id: string; full_name: string; work_email: string | null };

type StepKey = 'basics' | 'licenses' | 'optional' | 'review' | 'finish';

interface FormState {
  first_name: string;
  last_name: string;
  display_name: string;
  display_name_touched: boolean;
  username: string;
  domain: string;
  auto_password: boolean;
  manual_password: string;
  force_change: boolean;

  usage_location: string;     // ISO-2
  selected_skus: Set<string>; // sku_id

  // Optional Rudrans-side metadata
  designation: string;
  department_id: string;
  manager_id: string;
  doj: string;
  employee_code: string;
  personal_email: string;
}

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'basics',   label: 'Basics' },
  { key: 'licenses', label: 'Product licenses' },
  { key: 'optional', label: 'Optional settings' },
  { key: 'review',   label: 'Review and finish' },
];

const initial: FormState = {
  first_name: '', last_name: '', display_name: '', display_name_touched: false,
  username: '', domain: '',
  auto_password: true, manual_password: '', force_change: true,
  usage_location: 'IN',
  selected_skus: new Set<string>(),
  designation: '', department_id: '', manager_id: '',
  doj: '', employee_code: '', personal_email: '',
};

export default function NewM365User() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(initial);
  const [step, setStep] = useState<StepKey>('basics');
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [tenantErr, setTenantErr] = useState<string | null>(null);
  const [tenantLoading, setTenantLoading] = useState(true);
  const [depts, setDepts] = useState<Department[]>([]);
  const [managers, setManagers] = useState<EmployeeLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    work_email?: string;
    password?: string;
    force_change_password?: boolean;
    m365?: { ok?: boolean; error?: string; user_id?: string; licenses?: string; license_error?: string };
    employee_id?: string;
  } | null>(null);

  // Country dropdown — lazy-load `country-state-city` (8 MB) so the
  // M365 page first-paint isn't waiting on it.
  const [countries, setCountries] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void import('country-state-city').then((mod) => {
      if (cancelled) return;
      setCountries(mod.Country.getAllCountries().map((c) => ({ code: c.isoCode, name: c.name })));
    });
    return () => { cancelled = true; };
  }, []);

  // ---- Load tenant info + departments + managers ----
  const loadTenant = useCallback(async () => {
    setTenantLoading(true); setTenantErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/m365-tenant-info`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setTenant(j as TenantInfo);
      const def = (j.verified_domains as Domain[] | undefined)?.find((d) => d.isDefault) ?? (j.verified_domains as Domain[] | undefined)?.[0];
      if (def) setForm((f) => ({ ...f, domain: f.domain || def.name }));
    } catch (e) {
      setTenantErr((e as Error).message);
    } finally {
      setTenantLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTenant();
    (async () => {
      const [{ data: d }, { data: m }] = await Promise.all([
        supabase.from('org_departments').select('id, name').order('name'),
        supabase.from('employees').select('id, full_name, work_email').eq('status', 'active').order('full_name'),
      ]);
      setDepts((d ?? []) as Department[]);
      setManagers((m ?? []) as EmployeeLite[]);
    })();
  }, [loadTenant]);

  // ---- Field helpers ----
  const onChange = <K extends keyof FormState>(key: K, val: FormState[K]) => {
    setForm((f) => {
      const next = { ...f, [key]: val };
      // Auto-fill display_name from first+last until the user manually edits it.
      if ((key === 'first_name' || key === 'last_name') && !f.display_name_touched) {
        next.display_name = `${next.first_name} ${next.last_name}`.trim();
      }
      return next;
    });
  };
  const setUsername = (v: string) =>
    onChange('username', v.toLowerCase().replace(/[^a-z0-9._-]/g, ''));

  const upnPreview = form.username && form.domain ? `${form.username}@${form.domain}` : '—';

  const toggleSku = (skuId: string) => {
    setForm((f) => {
      const next = new Set(f.selected_skus);
      if (next.has(skuId)) next.delete(skuId); else next.add(skuId);
      return { ...f, selected_skus: next };
    });
  };

  // ---- Step gating ----
  const validateStep = (s: StepKey): string | null => {
    if (s === 'basics') {
      if (!form.display_name.trim()) return 'Display name required';
      if (!form.username.trim()) return 'Username required';
      if (!form.domain) return 'Domain required';
      if (!form.auto_password) {
        if (form.manual_password.length < 8) return 'Password must be at least 8 characters';
      }
    }
    if (s === 'licenses') {
      if (!form.usage_location) return 'Select a location';
    }
    return null;
  };

  const goNext = () => {
    const v = validateStep(step);
    if (v) { setErr(v); return; }
    setErr(null);
    const idx = STEPS.findIndex((x) => x.key === step);
    if (idx >= 0 && idx < STEPS.length - 1) setStep(STEPS[idx + 1].key);
  };
  const goBack = () => {
    setErr(null);
    const idx = STEPS.findIndex((x) => x.key === step);
    if (idx > 0) setStep(STEPS[idx - 1].key);
  };

  // ---- Submit ----
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/provision-employee`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: form.display_name.trim(),
          display_name: form.display_name.trim(),
          given_name: form.first_name.trim() || undefined,
          surname: form.last_name.trim() || undefined,
          mail_nickname: form.username.trim(),
          primary_domain: form.domain,
          designation: form.designation.trim() || undefined,
          department_id: form.department_id || undefined,
          manager_id: form.manager_id || undefined,
          doj: form.doj || undefined,
          employee_code: form.employee_code.trim() || undefined,
          personal_email: form.personal_email.trim() || undefined,
          create_m365: true,
          create_google: false,
          m365_usage_location: form.usage_location || 'IN',
          m365_license_skus: [...form.selected_skus],
          manual_password: form.auto_password ? undefined : form.manual_password,
          force_change_password: form.force_change,
          return_password: true,
        }),
      });
      const j = await r.json();
      // Accept 200 (full success), 207 (partial — DB warning), 400 (all-providers-failed,
      // shaped result body). Anything else with no shaped result is a hard error.
      if (!r.ok && r.status !== 207 && r.status !== 400) throw new Error(j.error ?? `${r.status}`);
      setResult(j);
      setStep('finish');
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  // ============== render ==============

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto">
        <header className="mb-6 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400">
            <i className="ri-arrow-left-line" />
          </button>
          <div>
            <h1 className="text-2xl font-poppins font-semibold text-white">Add a Microsoft 365 user</h1>
            <p className="text-sm text-gray-400">Provision an Azure AD account in your tenant. The user appears in Microsoft 365 admin center immediately.</p>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-[220px,1fr] gap-6">
          {/* Stepper */}
          <aside className="bg-dark-800 border border-dark-700 rounded-xl p-4 h-fit">
            <ol className="space-y-1">
              {STEPS.map((s, i) => {
                const done = STEPS.findIndex((x) => x.key === step) > i || step === 'finish';
                const active = step === s.key;
                return (
                  <li key={s.key} className="flex items-center gap-3 py-2">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                      done ? 'bg-emerald-500 text-white' :
                      active ? 'bg-blue-500 text-white' :
                      'bg-dark-700 text-gray-500'
                    }`}>
                      {done ? <i className="ri-check-line" /> : i + 1}
                    </span>
                    <span className={`text-sm ${active ? 'text-white font-medium' : 'text-gray-400'}`}>{s.label}</span>
                  </li>
                );
              })}
              <li className="flex items-center gap-3 py-2">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                  step === 'finish' ? 'bg-emerald-500 text-white' : 'bg-dark-700 text-gray-500'
                }`}>{step === 'finish' ? <i className="ri-check-line" /> : 5}</span>
                <span className={`text-sm ${step === 'finish' ? 'text-white font-medium' : 'text-gray-400'}`}>Finish</span>
              </li>
            </ol>
          </aside>

          {/* Body */}
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-6 space-y-4 min-h-[420px]">
            {tenantErr && (
              <div className="px-3 py-2 rounded-lg text-sm bg-rose-500/10 border border-rose-500/30 text-rose-300">
                Couldn't load tenant info: {tenantErr}
              </div>
            )}
            {err && (
              <div className="px-3 py-2 rounded-lg text-sm bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>
            )}

            {/* ============== BASICS ============== */}
            {step === 'basics' && (
              <>
                <h2 className="text-lg text-white font-semibold mb-1">Basics</h2>
                <p className="text-xs text-gray-400 mb-3">Start by filling in the basics. After that we'll create the user in your tenant.</p>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="First name">
                    <Input value={form.first_name} onChange={(v) => onChange('first_name', v)} placeholder="Priya" />
                  </Field>
                  <Field label="Last name">
                    <Input value={form.last_name} onChange={(v) => onChange('last_name', v)} placeholder="Sharma" />
                  </Field>
                </div>
                <Field label="Display name *">
                  <Input
                    value={form.display_name}
                    onChange={(v) => { onChange('display_name', v); onChange('display_name_touched', true); }}
                    placeholder="Priya Sharma"
                  />
                </Field>

                <div className="grid grid-cols-[1fr,16px,1fr] gap-2 items-end">
                  <Field label="Username *">
                    <Input value={form.username} onChange={setUsername} placeholder="priya.sharma" />
                  </Field>
                  <div className="text-gray-500 text-xl mb-2 text-center">@</div>
                  <Field label="Domain *">
                    {tenantLoading ? (
                      <div className="h-9 bg-dark-900 border border-dark-700 rounded-lg animate-pulse" />
                    ) : (
                      <select value={form.domain} onChange={(e) => onChange('domain', e.target.value)} className={inputCls}>
                        {(tenant?.verified_domains ?? []).map((d) => (
                          <option key={d.name} value={d.name}>{d.name.toUpperCase()}{d.isDefault ? ' (default)' : ''}</option>
                        ))}
                      </select>
                    )}
                  </Field>
                </div>
                <p className="text-xs text-emerald-300 font-mono mt-1">UPN preview: {upnPreview}</p>

                <div className="pt-3 border-t border-dark-700 space-y-3">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={form.auto_password} onChange={(e) => onChange('auto_password', e.target.checked)} className="mt-1" />
                    <div>
                      <p className="text-sm text-white">Automatically create a password</p>
                      <p className="text-xs text-gray-500">A strong 16-character password is generated server-side and shown on the Finish step.</p>
                    </div>
                  </label>

                  {!form.auto_password && (
                    <Field label="Password *">
                      <Input value={form.manual_password} onChange={(v) => onChange('manual_password', v)} type="password" placeholder="At least 8 characters" />
                      <p className="text-[11px] text-gray-500 mt-1">Use a combination of at least three of: uppercase, lowercase, numbers, symbols.</p>
                    </Field>
                  )}

                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={form.force_change} onChange={(e) => onChange('force_change', e.target.checked)} className="mt-1" />
                    <p className="text-sm text-white">Require this user to change their password when they first sign in</p>
                  </label>
                </div>
              </>
            )}

            {/* ============== LICENSES ============== */}
            {step === 'licenses' && (
              <>
                <h2 className="text-lg text-white font-semibold mb-1">Assign product licenses</h2>
                <p className="text-xs text-gray-400 mb-4">Assign the licenses you'd like this user to have. Counts are pulled live from your tenant.</p>

                <Field label="Select location *">
                  <select value={form.usage_location} onChange={(e) => onChange('usage_location', e.target.value)} className={inputCls}>
                    {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select>
                </Field>

                <div className="pt-3">
                  <p className="text-sm text-white mb-2">Licenses ({form.selected_skus.size})</p>
                  {tenantLoading ? (
                    <div className="text-xs text-gray-500">Loading…</div>
                  ) : !tenant?.subscribed_skus.length ? (
                    <div className="text-xs text-gray-500">No SKUs found in this tenant.</div>
                  ) : (
                    <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                      {tenant.subscribed_skus.map((s) => {
                        const out = s.available <= 0;
                        const checked = form.selected_skus.has(s.sku_id);
                        return (
                          <label key={s.sku_id}
                            className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${
                              checked ? 'border-blue-500/50 bg-blue-500/5' : 'border-dark-700 hover:bg-dark-700/30'
                            }`}>
                            <input type="checkbox" checked={checked} onChange={() => toggleSku(s.sku_id)} className="mt-1" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-white font-medium">{s.display_name}</p>
                              <p className="text-xs text-gray-500">
                                {out
                                  ? `You're out of licenses. If you turn this on, Microsoft will try to buy an additional license for you.`
                                  : `${s.available} of ${s.enabled} licenses available`}
                              </p>
                              <p className="text-[10px] text-gray-600 mt-0.5 font-mono">{s.sku_part_number}</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ============== OPTIONAL ============== */}
            {step === 'optional' && (
              <>
                <h2 className="text-lg text-white font-semibold mb-1">Optional settings</h2>
                <p className="text-xs text-gray-400 mb-3">These are stored in Rudrans for org context; Microsoft doesn't need them.</p>

                <Field label="Job title">
                  <Input value={form.designation} onChange={(v) => onChange('designation', v)} placeholder="Software Engineer" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Department">
                    <select value={form.department_id} onChange={(e) => onChange('department_id', e.target.value)} className={inputCls}>
                      <option value="">— none —</option>
                      {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Reports to">
                    <select value={form.manager_id} onChange={(e) => onChange('manager_id', e.target.value)} className={inputCls}>
                      <option value="">— none —</option>
                      {managers.map((m) => <option key={m.id} value={m.id}>{m.full_name}{m.work_email ? ` · ${m.work_email}` : ''}</option>)}
                    </select>
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Date of joining">
                    <Input value={form.doj} onChange={(v) => onChange('doj', v)} type="date" />
                  </Field>
                  <Field label="Employee code (HR)">
                    <Input value={form.employee_code} onChange={(v) => onChange('employee_code', v)} placeholder="EMP-1234" />
                  </Field>
                </div>
                <Field label="Personal email (welcome mail copy)">
                  <Input value={form.personal_email} onChange={(v) => onChange('personal_email', v)} placeholder="priya@gmail.com" type="email" />
                </Field>
              </>
            )}

            {/* ============== REVIEW ============== */}
            {step === 'review' && (
              <>
                <h2 className="text-lg text-white font-semibold mb-1">Review and finish</h2>
                <p className="text-xs text-gray-400 mb-3">Review all the info and settings for this user before you finish adding them.</p>

                <ReviewBlock title="Display and username">
                  <p className="text-white">{form.display_name}</p>
                  <p className="text-gray-400 text-sm font-mono">{upnPreview}</p>
                </ReviewBlock>

                <ReviewBlock title="Password">
                  <p className="text-sm text-gray-300">Type: {form.auto_password ? 'Auto-generated' : 'Custom'}</p>
                  <p className="text-sm text-gray-300">Change on first sign-in: {form.force_change ? 'Yes' : 'No'}</p>
                </ReviewBlock>

                <ReviewBlock title="Product licenses">
                  <p className="text-sm text-gray-300">Location: {countries.find((c) => c.code === form.usage_location)?.name ?? form.usage_location}</p>
                  <p className="text-sm text-gray-300">Licenses: {form.selected_skus.size === 0 ? 'None' :
                    [...form.selected_skus]
                      .map((id) => tenant?.subscribed_skus.find((s) => s.sku_id === id)?.display_name ?? id)
                      .join(', ')}
                  </p>
                </ReviewBlock>

                <ReviewBlock title="Optional">
                  <p className="text-sm text-gray-300">Job title: {form.designation || '—'}</p>
                  <p className="text-sm text-gray-300">Department: {depts.find((d) => d.id === form.department_id)?.name ?? '—'}</p>
                  <p className="text-sm text-gray-300">Manager: {managers.find((m) => m.id === form.manager_id)?.full_name ?? '—'}</p>
                  <p className="text-sm text-gray-300">DOJ: {form.doj || '—'}</p>
                  <p className="text-sm text-gray-300">Personal email: {form.personal_email || '—'}</p>
                </ReviewBlock>
              </>
            )}

            {/* ============== FINISH ============== */}
            {step === 'finish' && result && (
              <FinishScreen
                result={result}
                displayName={form.display_name}
                onAddAnother={() => { setForm(initial); setResult(null); setStep('basics'); }}
              />
            )}

            {/* Footer */}
            {step !== 'finish' && (
              <div className="pt-4 mt-2 border-t border-dark-700 flex justify-between">
                {step !== 'basics'
                  ? <button onClick={goBack} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Back</button>
                  : <Link to="/employees" className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Cancel</Link>}
                {step === 'review' ? (
                  <button onClick={submit} disabled={busy} className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
                    {busy ? 'Adding user…' : 'Finish adding'}
                  </button>
                ) : (
                  <button onClick={goNext} className="px-5 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm text-white font-medium">Next</button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

// ============== Finish screen ==============

function FinishScreen({
  result, displayName, onAddAnother,
}: {
  result: Record<string, unknown> & { work_email?: string; password?: string; m365?: { ok?: boolean; error?: string; licenses?: string; license_error?: string }; employee_id?: string; employee_insert_error?: string };
  displayName: string;
  onAddAnother: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const m365 = result.m365;
  const success = m365?.ok === true;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <span className={`w-10 h-10 rounded-full ${success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'} flex items-center justify-center`}>
          <i className={success ? 'ri-check-line text-xl' : 'ri-close-line text-xl'} />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl text-white font-semibold">{displayName} {success ? 'added to active users' : 'could not be added'}</h2>
          <p className="text-xs text-gray-500">{success ? `${displayName} will now appear in your list of active users.` : 'See the error details below.'}</p>
        </div>
      </div>

      {!success && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-rose-500/10 border border-rose-500/30">
          <p className="text-xs uppercase tracking-wider text-rose-400 mb-1">Microsoft 365 error</p>
          <p className="text-sm text-rose-200 break-words whitespace-pre-wrap">
            {m365?.error ?? '(no error message returned from Graph)'}
          </p>
          {result.employee_insert_error && (
            <>
              <p className="text-xs uppercase tracking-wider text-rose-400 mt-3 mb-1">Rudrans DB error</p>
              <p className="text-sm text-rose-200 break-words whitespace-pre-wrap">{result.employee_insert_error}</p>
            </>
          )}
          <button onClick={() => setRawOpen((x) => !x)} className="text-xs text-rose-300 hover:text-rose-200 mt-3 underline">
            {rawOpen ? 'Hide' : 'Show'} raw response
          </button>
          {rawOpen && (
            <pre className="mt-2 p-2 bg-dark-900 rounded text-[11px] text-gray-300 overflow-x-auto max-h-64">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}

      {success && (
        <div className="bg-dark-900/60 border border-dark-700 rounded-xl p-5 space-y-3">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider">Display name</p>
            <p className="text-sm text-white">{displayName}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider">Username</p>
            <p className="text-sm text-white font-mono">{result.work_email}</p>
          </div>
          {result.password && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider">Password</p>
              <div className="flex items-center gap-2">
                <code className="text-sm text-white font-mono bg-dark-900 px-3 py-1.5 rounded">
                  {shown ? result.password : '••••••••••••••'}
                </code>
                <button onClick={() => setShown((x) => !x)} className="text-xs text-blue-400 hover:text-blue-300">
                  {shown ? 'Hide' : 'Show'}
                </button>
                <button onClick={() => navigator.clipboard.writeText(result.password ?? '')} className="text-xs text-blue-400 hover:text-blue-300">
                  Copy
                </button>
              </div>
              <p className="text-[11px] text-gray-500 mt-1">Save this — it won't be shown again from this screen.</p>
            </div>
          )}
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider">Licenses assigned</p>
            <p className="text-sm text-white">{m365?.licenses === 'assigned' ? 'Yes' : (m365?.license_error ? `Failed: ${m365.license_error}` : 'None')}</p>
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-5">
        <Link to="/employees" className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Back to employees</Link>
        <button onClick={onAddAnother} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm text-white font-medium">Add another</button>
      </div>
    </div>
  );
}

// ============== small helpers ==============

const inputCls = "w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-xs text-gray-400 mb-1">{label}</span>{children}</label>;
}
function Input({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputCls} />;
}
function ReviewBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-3 border-b border-dark-700/50 last:border-0">
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{title}</p>
      {children}
    </div>
  );
}
