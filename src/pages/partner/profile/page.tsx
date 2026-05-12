import { useEffect, useMemo, useState } from 'react';
import PartnerLayout from '../PartnerLayout';
import { supabase } from '@/lib/supabase';
import { useAppRole } from '@/lib/useAppRole';
import PhoneInput from '@/components/forms/PhoneInput';
import CountryStatePicker from '@/components/forms/CountryStatePicker';

type Partner = {
  id: string;
  name: string;
  contact_email: string;
  contact_person: string | null;
  phone: string | null;
  gst_number: string | null;
  pan_number: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  status: string;
  commission_pct: number;
  bank_account_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_name: string | null;
  payment_mode: string | null;
  notes: string | null;
  gst_certificate_url: string | null;
  authorization_letter_url: string | null;
  cancelled_cheque_url: string | null;
  created_at: string;
};

const labelCls   = 'block text-[11px] uppercase tracking-wider text-gray-500 mb-1.5';
const inputCls   = 'w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-violet-500';
const readonlyCls = 'w-full bg-dark-900/60 border border-dark-800 rounded-lg px-3 py-2 text-sm text-gray-400';

export default function PartnerProfile() {
  const { partnerId } = useAppRole();
  const [p, setP] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [draft, setDraft] = useState<Partial<Partner>>({});

  const load = async () => {
    if (!partnerId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('partners')
      .select('*')
      .eq('id', partnerId)
      .single();
    if (error) setMsg({ kind: 'err', text: error.message });
    setP((data as Partner) ?? null);
    setDraft({});
    setLoading(false);
  };
  useEffect(() => { load(); }, [partnerId]);

  const dirty = useMemo(
    () => Object.entries(draft).some(([k, v]) => p && (p as Record<string, unknown>)[k] !== v),
    [draft, p],
  );

  const setField = <K extends keyof Partner>(k: K, v: Partner[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const get = <K extends keyof Partner>(k: K): Partner[K] | undefined =>
    (draft[k] !== undefined ? draft[k] : p?.[k]) as Partner[K] | undefined;

  const save = async () => {
    if (!p || !dirty) return;
    setSaving(true); setMsg(null);
    // Only send the editable subset — server enforces this too via trigger,
    // but stripping locally avoids confusing "permission denied" on safe fields.
    const editable: (keyof Partner)[] = [
      'contact_person', 'phone', 'gst_number', 'pan_number',
      'address', 'city', 'state', 'country', 'postal_code',
      'bank_account_name', 'bank_account_number', 'bank_ifsc', 'bank_name', 'payment_mode',
    ];
    const payload: Record<string, unknown> = {};
    for (const k of editable) if (draft[k] !== undefined) payload[k] = draft[k];

    const { error } = await supabase.from('partners').update(payload).eq('id', p.id);
    setSaving(false);
    if (error) setMsg({ kind: 'err', text: error.message });
    else { setMsg({ kind: 'ok', text: 'Profile updated.' }); await load(); }
  };

  const openDoc = async (path: string | null) => {
    if (!path) return;
    // Documents live in the private `partner-documents` bucket — fetch a signed
    // URL good for 5 minutes rather than exposing the raw object.
    const { data, error } = await supabase.storage.from('partner-documents').createSignedUrl(path, 300);
    if (error) { setMsg({ kind: 'err', text: error.message }); return; }
    window.open(data?.signedUrl ?? '#', '_blank', 'noopener');
  };

  if (loading) {
    return <PartnerLayout title="Profile"><p className="text-xs text-gray-500">Loading…</p></PartnerLayout>;
  }
  if (!p) {
    return <PartnerLayout title="Profile"><p className="text-xs text-gray-500">No partner record found for your account.</p></PartnerLayout>;
  }

  const statusColor: Record<string, string> = {
    active:    'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    pending:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
    suspended: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
    rejected:  'bg-rose-500/15 text-rose-300 border-rose-500/30',
  };

  return (
    <PartnerLayout title="Profile">
      {/* HEADER CARD: identity + read-only stats */}
      <section className="bg-dark-800 border border-dark-700 rounded-xl p-5 mb-5">
        <div className="flex flex-wrap items-start gap-4 justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-white truncate">{p.name}</h2>
              <span className={`px-2 py-0.5 text-[10px] rounded-md border capitalize ${statusColor[p.status] ?? 'bg-dark-700 text-gray-400 border-dark-600'}`}>{p.status}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">{p.contact_email}</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
            <div>
              <p className="text-gray-500 text-[10px] uppercase tracking-wider">Commission</p>
              <p className="text-violet-300 font-medium">{Number(p.commission_pct).toFixed(0)}%</p>
            </div>
            <div>
              <p className="text-gray-500 text-[10px] uppercase tracking-wider">Joined</p>
              <p className="text-gray-300">{new Date(p.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</p>
            </div>
            <div>
              <p className="text-gray-500 text-[10px] uppercase tracking-wider">Partner ID</p>
              <p className="text-gray-400 font-mono text-[10px] truncate" title={p.id}>{p.id.slice(0, 8)}…</p>
            </div>
          </div>
        </div>
        <p className="text-[11px] text-gray-500 mt-4 max-w-xl">
          <i className="ri-information-line mr-1" />
          Your name, billing email, status and commission rate are managed by Rudrans admins. To change any of these, contact <a href="mailto:itsupport@wellnessextract.com" className="text-violet-400">itsupport@wellnessextract.com</a>.
        </p>
      </section>

      {msg && (
        <div className={`mb-4 px-3 py-2 rounded-lg text-xs border ${msg.kind === 'ok' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-300'}`}>
          {msg.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* CONTACT */}
        <section className="bg-dark-800 border border-dark-700 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <i className="ri-contacts-line text-violet-400" /> Contact
          </h3>
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Contact Person</label>
              <input value={(get('contact_person') as string) ?? ''} onChange={(e) => setField('contact_person', e.target.value)} className={inputCls} placeholder="Primary contact name" />
            </div>
            <div>
              <label className={labelCls}>Email <span className="text-gray-600 normal-case">(admin-managed)</span></label>
              <input value={p.contact_email} disabled className={readonlyCls} />
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <PhoneInput value={(get('phone') as string) ?? ''} onChange={(v) => setField('phone', v)} defaultCountry={(get('country') as string) || 'IN'} />
            </div>
          </div>
        </section>

        {/* TAX */}
        <section className="bg-dark-800 border border-dark-700 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <i className="ri-bill-line text-violet-400" /> Tax Identifiers
          </h3>
          <div className="space-y-4">
            <div>
              <label className={labelCls}>GST Number</label>
              <input value={(get('gst_number') as string) ?? ''} onChange={(e) => setField('gst_number', e.target.value.toUpperCase())} className={inputCls} placeholder="15-character GSTIN" maxLength={15} />
            </div>
            <div>
              <label className={labelCls}>PAN Number</label>
              <input value={(get('pan_number') as string) ?? ''} onChange={(e) => setField('pan_number', e.target.value.toUpperCase())} className={inputCls} placeholder="10-character PAN" maxLength={10} />
            </div>
          </div>
        </section>

        {/* ADDRESS */}
        <section className="bg-dark-800 border border-dark-700 rounded-xl p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <i className="ri-map-pin-line text-violet-400" /> Address
          </h3>
          <div className="space-y-4">
            <div>
              <label className={labelCls}>Street / Building</label>
              <input value={(get('address') as string) ?? ''} onChange={(e) => setField('address', e.target.value)} className={inputCls} />
            </div>
            <CountryStatePicker
              country={(get('country') as string) ?? 'India'}
              state={(get('state') as string) ?? ''}
              city={(get('city') as string) ?? ''}
              onChange={({ country, state, city }) => setDraft((d) => ({ ...d, country, state, city }))}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>PIN / Postal Code</label>
                <input value={(get('postal_code') as string) ?? ''} onChange={(e) => setField('postal_code', e.target.value)} className={inputCls} maxLength={10} />
              </div>
            </div>
          </div>
        </section>

        {/* BANK */}
        <section className="bg-dark-800 border border-dark-700 rounded-xl p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <i className="ri-bank-line text-violet-400" /> Bank Details
            <span className="ml-2 text-[10px] font-normal text-gray-500">Used to pay your commission</span>
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Account Holder Name</label>
              <input value={(get('bank_account_name') as string) ?? ''} onChange={(e) => setField('bank_account_name', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Bank Name</label>
              <input value={(get('bank_name') as string) ?? ''} onChange={(e) => setField('bank_name', e.target.value)} className={inputCls} placeholder="e.g. HDFC Bank" />
            </div>
            <div>
              <label className={labelCls}>Account Number</label>
              <input value={(get('bank_account_number') as string) ?? ''} onChange={(e) => setField('bank_account_number', e.target.value.replace(/\D/g, ''))} className={inputCls} maxLength={20} />
            </div>
            <div>
              <label className={labelCls}>IFSC Code</label>
              <input value={(get('bank_ifsc') as string) ?? ''} onChange={(e) => setField('bank_ifsc', e.target.value.toUpperCase())} className={inputCls} placeholder="ABCD0123456" maxLength={11} />
            </div>
            <div>
              <label className={labelCls}>Payment Mode</label>
              <select value={(get('payment_mode') as string) ?? ''} onChange={(e) => setField('payment_mode', e.target.value)} className={inputCls}>
                <option value="">— Select —</option>
                <option value="bank_transfer">Bank Transfer (NEFT/RTGS/IMPS)</option>
                <option value="upi">UPI</option>
                <option value="cheque">Cheque</option>
              </select>
            </div>
          </div>
        </section>

        {/* DOCUMENTS */}
        <section className="bg-dark-800 border border-dark-700 rounded-xl p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <i className="ri-file-paper-line text-violet-400" /> Documents on File
            <span className="ml-2 text-[10px] font-normal text-gray-500">Re-upload by contacting admin</span>
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: 'GST Certificate',      url: p.gst_certificate_url },
              { label: 'Authorization Letter', url: p.authorization_letter_url },
              { label: 'Cancelled Cheque',     url: p.cancelled_cheque_url },
            ].map((d) => (
              <button
                key={d.label}
                disabled={!d.url}
                onClick={() => openDoc(d.url)}
                className="text-left px-3 py-3 rounded-lg border border-dark-700 bg-dark-900/60 hover:border-violet-500/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <p className="text-xs text-gray-300">{d.label}</p>
                <p className={`text-[11px] mt-1 ${d.url ? 'text-violet-300' : 'text-gray-600'}`}>
                  {d.url ? 'View document →' : 'Not uploaded'}
                </p>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* STICKY SAVE BAR */}
      <div className="sticky bottom-0 mt-5 -mx-6 px-6 py-3 bg-dark-900/80 backdrop-blur border-t border-dark-700 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => { setDraft({}); setMsg(null); }}
          className="px-3 py-2 text-xs rounded-lg bg-dark-800 hover:bg-dark-700 text-gray-300 disabled:opacity-40"
        >
          Discard
        </button>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={save}
          className="px-4 py-2 text-xs rounded-lg bg-violet-500 text-white hover:bg-violet-400 disabled:opacity-40 font-medium"
        >
          {saving ? 'Saving…' : dirty ? 'Save Changes' : 'No changes'}
        </button>
      </div>
    </PartnerLayout>
  );
}
