import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';

type OrgIntegration = {
  provider: 'm365' | 'google';
  primary_domain: string | null;
  status: string;
};
type Department = { id: string; name: string };
type EmployeeLite = { id: string; full_name: string; work_email: string | null };

interface FormState {
  full_name: string;
  given_name: string;
  surname: string;
  personal_email: string;
  mail_nickname: string;
  primary_domain: string;
  designation: string;
  department_id: string;
  manager_id: string;
  doj: string;
  employee_code: string;
  create_m365: boolean;
  create_google: boolean;
  m365_usage_location: string;
  m365_license_skus: string;        // comma-separated GUIDs (textarea-ish input)
}

const empty: FormState = {
  full_name: '', given_name: '', surname: '',
  personal_email: '', mail_nickname: '', primary_domain: '',
  designation: '', department_id: '', manager_id: '',
  doj: '', employee_code: '',
  create_m365: true, create_google: false,
  m365_usage_location: 'IN', m365_license_skus: '',
};

export default function NewEmployee() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(empty);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [integ, setInteg] = useState<OrgIntegration[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [managers, setManagers] = useState<EmployeeLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: i }, { data: d }, { data: m }] = await Promise.all([
      supabase.from('org_integrations_safe').select('provider, primary_domain, status'),
      supabase.from('org_departments').select('id, name').order('name'),
      supabase.from('employees').select('id, full_name, work_email').eq('status', 'active').order('full_name'),
    ]);
    setInteg((i ?? []) as OrgIntegration[]);
    setDepts((d ?? []) as Department[]);
    setManagers((m ?? []) as EmployeeLite[]);
    const m365 = (i ?? []).find((x) => x.provider === 'm365');
    const google = (i ?? []).find((x) => x.provider === 'google');
    setForm((f) => ({
      ...f,
      primary_domain: f.primary_domain || m365?.primary_domain || google?.primary_domain || '',
      create_m365: !!m365 && m365.status === 'active',
      create_google: false,    // opt-in if both connected (avoid double-provisioning by default)
    }));
  }, []);

  useEffect(() => { load(); }, [load]);

  const m365Active = integ.some((x) => x.provider === 'm365' && x.status === 'active');
  const googleActive = integ.some((x) => x.provider === 'google' && x.status === 'active');
  const upnPreview = form.mail_nickname && form.primary_domain
    ? `${form.mail_nickname}@${form.primary_domain}` : '—';

  const onChange = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const next = () => {
    if (step === 1) {
      if (!form.full_name.trim()) { setError('Full name required'); return; }
      if (!form.mail_nickname.trim()) { setError('Mail nickname required'); return; }
      if (!form.primary_domain.trim()) { setError('Primary domain required'); return; }
      setError(null); setStep(2);
    } else if (step === 2) {
      if (!form.create_m365 && !form.create_google) {
        setError('Pick at least one provider (M365 or Google)'); return;
      }
      setError(null); setStep(3);
    }
  };

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const skus = form.m365_license_skus.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/provision-employee`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_name: form.full_name.trim(),
            given_name: form.given_name.trim() || undefined,
            surname: form.surname.trim() || undefined,
            personal_email: form.personal_email.trim() || undefined,
            mail_nickname: form.mail_nickname.trim(),
            primary_domain: form.primary_domain.trim(),
            designation: form.designation.trim() || undefined,
            department_id: form.department_id || undefined,
            manager_id: form.manager_id || undefined,
            doj: form.doj || undefined,
            employee_code: form.employee_code.trim() || undefined,
            create_m365: form.create_m365,
            create_google: form.create_google,
            m365_usage_location: form.m365_usage_location || 'IN',
            m365_license_skus: skus.length ? skus : undefined,
          }),
        },
      );
      const j = await r.json();
      if (!r.ok && r.status !== 207) throw new Error(j.error ?? `${r.status}`);
      setResult(j);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  if (result) {
    const m365 = result.m365 as { ok?: boolean; error?: string; user_id?: string } | undefined;
    const google = result.google as { ok?: boolean; error?: string; user_id?: string } | undefined;
    const welcome = result.welcome_mail as { ok?: boolean; error?: string; skipped?: string } | undefined;
    return (
      <DashboardLayout>
        <div className="max-w-2xl mx-auto">
          <header className="mb-5">
            <h1 className="text-2xl font-poppins font-semibold text-white">Employee provisioned</h1>
            <p className="text-sm text-gray-400">{result.work_email as string ?? '—'}</p>
          </header>
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-3">
            <Outcome label="Microsoft 365" ok={m365?.ok} detail={m365?.error ?? m365?.user_id} />
            <Outcome label="Google Workspace" ok={google?.ok} detail={google?.error ?? google?.user_id} />
            <Outcome label="Welcome email" ok={welcome?.ok ?? (welcome?.skipped ? null : undefined)} detail={welcome?.error ?? welcome?.skipped ?? 'Sent to personal email'} />
            <div className="pt-3 flex gap-2 border-t border-dark-700">
              <Link to="/employees" className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Back to list</Link>
              <button
                onClick={() => { setResult(null); setForm(empty); setStep(1); load(); }}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white"
              >Add another</button>
            </div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto">
        <header className="mb-5 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-400">
            <i className="ri-arrow-left-line" />
          </button>
          <div>
            <h1 className="text-2xl font-poppins font-semibold text-white">Add employee</h1>
            <p className="text-sm text-gray-400">Step {step} of 3</p>
          </div>
        </header>

        <div className="flex gap-2 mb-5">
          {[1, 2, 3].map((s) => (
            <div key={s} className={`flex-1 h-1.5 rounded-full ${s <= step ? 'bg-emerald-500' : 'bg-dark-700'}`} />
          ))}
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg text-sm bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>
        )}

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-4">
          {step === 1 && (<>
            <Row label="Full name *">
              <Input value={form.full_name} onChange={(v) => onChange('full_name', v)} placeholder="Priya Sharma" />
            </Row>
            <div className="grid grid-cols-2 gap-3">
              <Row label="Given name">
                <Input value={form.given_name} onChange={(v) => onChange('given_name', v)} placeholder="Priya" />
              </Row>
              <Row label="Surname">
                <Input value={form.surname} onChange={(v) => onChange('surname', v)} placeholder="Sharma" />
              </Row>
            </div>
            <Row label="Personal email (welcome mail goes here)">
              <Input value={form.personal_email} onChange={(v) => onChange('personal_email', v)} placeholder="priya@gmail.com" type="email" />
            </Row>
            <Row label="Designation">
              <Input value={form.designation} onChange={(v) => onChange('designation', v)} placeholder="Software Engineer" />
            </Row>
            <Row label="Department">
              <select value={form.department_id} onChange={(e) => onChange('department_id', e.target.value)}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500">
                <option value="">— none —</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Row>
            <Row label="Reports to (manager)">
              <select value={form.manager_id} onChange={(e) => onChange('manager_id', e.target.value)}
                className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500">
                <option value="">— none —</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.full_name} {m.work_email ? `· ${m.work_email}` : ''}</option>)}
              </select>
            </Row>
            <div className="grid grid-cols-2 gap-3">
              <Row label="Date of joining">
                <Input value={form.doj} onChange={(v) => onChange('doj', v)} type="date" />
              </Row>
              <Row label="Employee code (HR)">
                <Input value={form.employee_code} onChange={(v) => onChange('employee_code', v)} placeholder="EMP-1234" />
              </Row>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <Row label="Mail nickname *">
                <Input value={form.mail_nickname} onChange={(v) => onChange('mail_nickname', v.toLowerCase().replace(/[^a-z0-9._-]/g, ''))} placeholder="priya.sharma" />
              </Row>
              <Row label="Primary domain *">
                <Input value={form.primary_domain} onChange={(v) => onChange('primary_domain', v)} placeholder="acme.com" />
              </Row>
              <Row label="Work email preview">
                <div className="px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-emerald-300 font-mono truncate">{upnPreview}</div>
              </Row>
            </div>
          </>)}

          {step === 2 && (<>
            <p className="text-xs text-gray-400">Pick where the account should be created. Both connected: account on each provider.</p>
            <label className={`flex items-start gap-3 p-3 rounded-lg border ${form.create_m365 ? 'border-blue-500/50 bg-blue-500/5' : 'border-dark-700'} ${!m365Active ? 'opacity-50' : 'cursor-pointer'}`}>
              <input type="checkbox" disabled={!m365Active} checked={form.create_m365} onChange={(e) => onChange('create_m365', e.target.checked)} className="mt-1" />
              <div>
                <p className="text-sm text-white font-medium">Microsoft 365 {!m365Active && <span className="text-xs text-gray-500">(not connected)</span>}</p>
                <p className="text-xs text-gray-500">Creates an Azure AD user + mailbox. Sign-in forced password change.</p>
              </div>
            </label>
            <label className={`flex items-start gap-3 p-3 rounded-lg border ${form.create_google ? 'border-amber-500/50 bg-amber-500/5' : 'border-dark-700'} ${!googleActive ? 'opacity-50' : 'cursor-pointer'}`}>
              <input type="checkbox" disabled={!googleActive} checked={form.create_google} onChange={(e) => onChange('create_google', e.target.checked)} className="mt-1" />
              <div>
                <p className="text-sm text-white font-medium">Google Workspace {!googleActive && <span className="text-xs text-gray-500">(not connected)</span>}</p>
                <p className="text-xs text-gray-500">Creates a Workspace user. Sign-in forced password change.</p>
              </div>
            </label>

            {form.create_m365 && (
              <div className="mt-4 space-y-3 p-3 rounded-lg bg-dark-900/60 border border-dark-700">
                <p className="text-xs text-blue-300 font-medium">Microsoft 365 license (optional)</p>
                <div className="grid grid-cols-2 gap-3">
                  <Row label="Usage location (ISO-2)">
                    <Input value={form.m365_usage_location} onChange={(v) => onChange('m365_usage_location', v.toUpperCase().slice(0, 2))} placeholder="IN" />
                  </Row>
                  <Row label="License SKU IDs (comma-separated GUIDs)">
                    <Input value={form.m365_license_skus} onChange={(v) => onChange('m365_license_skus', v)} placeholder="6fd2c87f-..." />
                  </Row>
                </div>
                <p className="text-[11px] text-gray-500">Find SkuId values via Graph: <span className="font-mono">GET /subscribedSkus</span>. Leave blank to skip.</p>
              </div>
            )}
          </>)}

          {step === 3 && (<>
            <p className="text-xs text-gray-400">Review and submit. A temporary password will be generated server-side and emailed to {form.personal_email || 'the personal email'}.</p>
            <Review label="Full name" value={form.full_name} />
            <Review label="Work email" value={upnPreview} />
            <Review label="Designation" value={form.designation || '—'} />
            <Review label="Department" value={depts.find((d) => d.id === form.department_id)?.name ?? '—'} />
            <Review label="Manager" value={managers.find((m) => m.id === form.manager_id)?.full_name ?? '—'} />
            <Review label="DOJ" value={form.doj || '—'} />
            <Review label="Create M365" value={form.create_m365 ? 'Yes' : 'No'} />
            <Review label="Create Google" value={form.create_google ? 'Yes' : 'No'} />
            {form.create_m365 && form.m365_license_skus && <Review label="License SKUs" value={form.m365_license_skus} />}
            <Review label="Personal email" value={form.personal_email || '— (welcome mail will be skipped)'} />
          </>)}

          <div className="pt-3 flex justify-between border-t border-dark-700">
            {step > 1 ? (
              <button onClick={() => setStep((s) => (s === 3 ? 2 : 1))} className="px-4 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">Back</button>
            ) : <span />}
            {step < 3 ? (
              <button onClick={next} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">Next</button>
            ) : (
              <button onClick={submit} disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
                {busy ? 'Provisioning…' : 'Provision employee'}
              </button>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-400 mb-1">{label}</span>
      {children}
    </label>
  );
}
function Input({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500" />
  );
}
function Review({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm py-1.5 border-b border-dark-700/50">
      <span className="text-gray-500">{label}</span>
      <span className="text-white text-right truncate ml-3">{value}</span>
    </div>
  );
}
function Outcome({ label, ok, detail }: { label: string; ok: boolean | null | undefined; detail?: string }) {
  const colour = ok === true ? 'text-emerald-400' : ok === false ? 'text-rose-400' : 'text-gray-400';
  const icon = ok === true ? 'ri-check-line' : ok === false ? 'ri-close-line' : 'ri-subtract-line';
  return (
    <div className="flex items-start gap-3">
      <span className={`w-6 h-6 rounded-full bg-dark-700 ${colour} flex items-center justify-center mt-0.5`}>
        <i className={icon} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white font-medium">{label}</p>
        {detail && <p className={`text-xs ${colour} break-words`}>{detail}</p>}
      </div>
    </div>
  );
}
