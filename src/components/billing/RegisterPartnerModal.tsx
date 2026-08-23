import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { decodeGstin, GSTIN_REGEX } from '@/lib/gst';
import CountryStatePicker from '@/components/forms/CountryStatePicker';
import PhoneInput from '@/components/forms/PhoneInput';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const inputCls =
  'w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500';

export default function RegisterPartnerModal({ open, onClose, onCreated }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ partnerId: string; email: string } | null>(null);
  const [inviteStatus, setInviteStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [gstLookupBusy, setGstLookupBusy] = useState(false);
  const [gstLookupErr, setGstLookupErr] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: '',
    contactPerson: '',
    contactEmail: '',
    phone: '',
    gstNumber: '',
    panNumber: '',
    address: '',
    country: 'IN',
    state: '',
    city: '',
    postalCode: '',
    commissionPct: 10,
    paymentMode: 'bank_transfer',
    bankAccountName: '',
    bankAccountNumber: '',
    bankIfsc: '',
    bankName: '',
    notes: '',
  });
  const [docs, setDocs] = useState<{ gst?: File; auth?: File; cheque?: File }>({});
  const setDoc = (key: 'gst' | 'auth' | 'cheque', f: File | null) =>
    setDocs((prev) => ({ ...prev, [key]: f ?? undefined }));
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((p) => ({ ...p, [k]: v }));

  const reset = () => {
    setForm({
      name: '', contactPerson: '', contactEmail: '', phone: '',
      gstNumber: '', panNumber: '', address: '', country: 'IN',
      state: '', city: '', postalCode: '', commissionPct: 10,
      paymentMode: 'bank_transfer',
      bankAccountName: '', bankAccountNumber: '', bankIfsc: '', bankName: '', notes: '',
    });
    setDocs({});
    setError(null); setSuccess(null); setGstLookupErr(null);
    setInviteStatus('idle'); setInviteError(null);
  };

  const close = () => { reset(); onClose(); };

  const onGstChange = (raw: string) => {
    const next = raw.toUpperCase();
    set('gstNumber', next);
    const decoded = decodeGstin(next);
    if (decoded.valid) {
      setForm((p) => ({
        ...p,
        gstNumber: next,
        country: 'IN',
        state: decoded.stateName ?? p.state,
        panNumber: decoded.pan ?? p.panNumber,
      }));
    }
  };

  const lookupGst = async () => {
    if (!GSTIN_REGEX.test(form.gstNumber)) { setGstLookupErr('Invalid GSTIN format'); return; }
    setGstLookupBusy(true); setGstLookupErr(null);
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gst-lookup`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
        body: JSON.stringify({ gstin: form.gstNumber }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `lookup ${res.status}`);
      const d = j.data ?? {};
      setForm((p) => ({
        ...p,
        name: d.legal_name || d.trade_name || p.name,
        address: d.address ?? p.address,
        city: d.city ?? p.city,
        state: d.state ?? p.state,
        postalCode: d.pincode ?? p.postalCode,
        panNumber: d.pan ?? p.panNumber,
        country: 'IN',
      }));
    } catch (e) {
      setGstLookupErr((e as Error).message);
    } finally { setGstLookupBusy(false); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      const { data, error } = await supabase
        .from('partners')
        .insert({
          name: form.name.trim(),
          contact_person: form.contactPerson.trim() || null,
          contact_email: form.contactEmail.trim().toLowerCase(),
          phone: form.phone.trim() || null,
          gst_number: form.gstNumber.trim() || null,
          pan_number: form.panNumber.trim() || null,
          address: form.address.trim() || null,
          country: form.country || 'IN',
          state: form.state.trim() || null,
          city: form.city.trim() || null,
          postal_code: form.postalCode.trim() || null,
          commission_pct: form.commissionPct,
          status: 'active', // super-admin direct registration → straight to active (skip pending)
          payment_mode: form.paymentMode || null,
          bank_account_name: form.bankAccountName.trim() || null,
          bank_account_number: form.bankAccountNumber.trim() || null,
          bank_ifsc: form.bankIfsc.trim().toUpperCase() || null,
          bank_name: form.bankName.trim() || null,
          notes: form.notes.trim() || null,
        })
        .select('id')
        .single();
      if (error) throw error;
      const partnerId = data.id as string;

      // Upload supplied documents to private 'partner-documents' bucket. Path scheme:
      // <partner_id>/<doc-kind>-<timestamp>.<ext>. RLS already restricts read to super_admin
      // and to the partner themselves.
      const uploadDoc = async (key: 'gst' | 'auth' | 'cheque', f: File | undefined) => {
        if (!f) return null;
        const ext = f.name.split('.').pop() || 'bin';
        const path = `${partnerId}/${key}-${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage.from('partner-documents').upload(path, f, { upsert: true });
        if (upErr) throw new Error(`${key} upload failed: ${upErr.message}`);
        return path;
      };
      const [gstUrl, authUrl, chequeUrl] = await Promise.all([
        uploadDoc('gst', docs.gst),
        uploadDoc('auth', docs.auth),
        uploadDoc('cheque', docs.cheque),
      ]);
      if (gstUrl || authUrl || chequeUrl) {
        const updates: Record<string, string> = {};
        if (gstUrl)    updates.gst_certificate_url = gstUrl;
        if (authUrl)   updates.authorization_letter_url = authUrl;
        if (chequeUrl) updates.cancelled_cheque_url = chequeUrl;
        await supabase.from('partners').update(updates).eq('id', partnerId);
      }

      setSuccess({ partnerId, email: form.contactEmail.trim() });
      onCreated();

      // Send portal invite to the partner's contact email so they can log in.
      setInviteStatus('sending');
      try {
        const { data: sess } = await supabase.auth.getSession();
        const jwt = sess.session?.access_token;
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-invite-partner`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({
            partner_id: partnerId,
            email: form.contactEmail.trim(),
            full_name: form.contactPerson.trim() || null,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `invite ${res.status}`);
        }
        setInviteStatus('sent');
      } catch (e) {
        setInviteStatus('failed');
        setInviteError((e as Error).message);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4 overflow-y-auto" onClick={close}>
      <div className="max-w-5xl w-full bg-dark-800 border border-dark-700 rounded-xl my-6 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-dark-700 flex items-center justify-between bg-dark-800 rounded-t-xl flex-shrink-0">
          <div>
            <h2 className="text-white font-semibold text-base">{success ? 'Partner Registered' : 'Register New Partner'}</h2>
            {!success && <p className="text-[11px] text-gray-500 mt-0.5">Onboard a reseller / channel partner with their commission split and bank details</p>}
          </div>
          <button onClick={close} className="text-gray-400 hover:text-white p-1"><i className="ri-close-line text-xl" /></button>
        </div>

        {success ? (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
              <p className="text-sm text-emerald-300 font-medium">✓ Partner registered with status: Active</p>
              <p className="text-xs text-gray-400 mt-1">Commission rate: {form.commissionPct}%</p>
            </div>
            <div className={`text-xs rounded-lg border px-3 py-2 ${
              inviteStatus === 'sent'   ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' :
              inviteStatus === 'failed' ? 'bg-red-500/10 border-red-500/30 text-red-300' :
                                          'bg-cyan-500/10 border-cyan-500/30 text-cyan-300'
            }`}>
              {inviteStatus === 'sending' && <>📧 Sending portal invite to <strong>{success.email}</strong>…</>}
              {inviteStatus === 'sent' && <>✓ Portal invite emailed to <strong>{success.email}</strong>. They&apos;ll get a magic link to set their password and access the partner portal.</>}
              {inviteStatus === 'failed' && <>✗ Invite failed: {inviteError}. Partner is registered — you can resend later from the partner row actions.</>}
            </div>
            <button onClick={close} className="w-full bg-cyan-500 hover:bg-cyan-400 text-dark-950 py-2.5 rounded-lg font-medium text-sm">Done</button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {error && <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>}

              {/* Hero: Partner name */}
              <div>
                <label className="text-[11px] text-cyan-400 uppercase tracking-wider font-medium block mb-1.5">Partner / Company Name *</label>
                <input required value={form.name} onChange={(e) => set('name', e.target.value)}
                  className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2.5 text-base text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
                  placeholder="Enter partner / company name" />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* LEFT */}
                <div className="space-y-5">
                  <Section title="Contact">
                    <Field label="Contact Person *">
                      <input required value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} className={inputCls} placeholder="Enter contact person name" />
                    </Field>
                    <Field label="Contact Email *">
                      <input required type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} className={inputCls} placeholder="Enter email address" />
                    </Field>
                    <Field label="Phone">
                      <PhoneInput value={form.phone} onChange={(v) => set('phone', v)} defaultCountry={form.country || 'IN'} />
                    </Field>
                  </Section>

                  <Section title="Tax Identifiers">
                    <Grid cols={2}>
                      <Field label="GST Number">
                        <div className="flex gap-2">
                          <input value={form.gstNumber} onChange={(e) => onGstChange(e.target.value)} className={inputCls} placeholder="Enter 15-character GSTIN" maxLength={15} />
                          <button type="button" onClick={lookupGst} disabled={gstLookupBusy || !GSTIN_REGEX.test(form.gstNumber)}
                            className="px-3 rounded-lg text-xs whitespace-nowrap bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed">
                            {gstLookupBusy ? '…' : 'Auto-fill'}
                          </button>
                        </div>
                        {gstLookupErr && <p className="text-[11px] text-red-400 mt-1">{gstLookupErr}</p>}
                      </Field>
                      <Field label="PAN Number">
                        <input value={form.panNumber} onChange={(e) => set('panNumber', e.target.value.toUpperCase())} className={inputCls} placeholder="Enter 10-character PAN" maxLength={10} />
                      </Field>
                    </Grid>
                  </Section>

                  <Section title="Commission (renewal only)">
                    <Field label="Renewal Commission %">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0} max={100} step="0.01"
                          value={form.commissionPct}
                          onChange={(e) => set('commissionPct', Number(e.target.value))}
                          className={inputCls}
                          placeholder="10.00"
                        />
                        <span className="text-sm text-gray-500">%</span>
                      </div>
                      <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
                        <span className="text-amber-300">New customers:</span> partner pays the discounted partner price (built-in margin).
                        {' '}<span className="text-amber-300">Renewals:</span> partner additionally earns this % on the wholesale amount as a retention kicker.
                      </p>
                    </Field>
                  </Section>

                  <Section title="Documents (required for KYC)">
                    <DocUpload label="GST Certificate" accept=".pdf,.png,.jpg,.jpeg" file={docs.gst} onChange={(f) => setDoc('gst', f)} />
                    <DocUpload label="Authorization Letter (on letterhead)" accept=".pdf,.png,.jpg,.jpeg" file={docs.auth} onChange={(f) => setDoc('auth', f)} />
                    <DocUpload label="Cancelled Cheque" accept=".pdf,.png,.jpg,.jpeg" file={docs.cheque} onChange={(f) => setDoc('cheque', f)} />
                    <p className="text-[11px] text-gray-500">PDF / image, max ~5 MB each. Stored privately in `partner-documents` bucket.</p>
                  </Section>
                </div>

                {/* RIGHT */}
                <div className="space-y-5">
                  <Section title="Address">
                    <Field label="Street / Building">
                      <input value={form.address} onChange={(e) => set('address', e.target.value)} className={inputCls} placeholder="Enter street / building" />
                    </Field>
                    <CountryStatePicker
                      country={form.country}
                      state={form.state}
                      city={form.city}
                      onChange={({ country, state, city }) => setForm((p) => ({ ...p, country, state, city }))}
                    />
                    <Field label="PIN / Postal Code">
                      <input value={form.postalCode} onChange={(e) => set('postalCode', e.target.value)} className={inputCls} placeholder="Enter PIN / postal code" maxLength={10} />
                    </Field>
                  </Section>

                  <Section title="Payment to Wellness Extract">
                    <Field label="Preferred Payment Mode">
                      <select value={form.paymentMode} onChange={(e) => set('paymentMode', e.target.value)} className={inputCls}>
                        <option value="bank_transfer">Bank Transfer (NEFT/RTGS/IMPS)</option>
                        <option value="upi">UPI</option>
                        <option value="cheque">Cheque / DD</option>
                        <option value="other">Other</option>
                      </select>
                    </Field>
                    <Grid cols={2}>
                      <Field label="Account Holder Name">
                        <input value={form.bankAccountName} onChange={(e) => set('bankAccountName', e.target.value)} className={inputCls} placeholder="Name on account" />
                      </Field>
                      <Field label="Bank Name">
                        <input value={form.bankName} onChange={(e) => set('bankName', e.target.value)} className={inputCls} placeholder="e.g. HDFC Bank" />
                      </Field>
                    </Grid>
                    <Grid cols={2}>
                      <Field label="Account Number">
                        <input value={form.bankAccountNumber} onChange={(e) => set('bankAccountNumber', e.target.value.replace(/\D/g, ''))} className={inputCls} placeholder="Account number" maxLength={20} />
                      </Field>
                      <Field label="IFSC Code">
                        <input value={form.bankIfsc} onChange={(e) => set('bankIfsc', e.target.value.toUpperCase())} className={inputCls} placeholder="HDFC0001234" maxLength={11} />
                      </Field>
                    </Grid>
                    <Field label="Notes (internal)">
                      <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className={inputCls} />
                    </Field>
                  </Section>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-dark-700 bg-dark-800/95 backdrop-blur flex items-center justify-end gap-2 flex-shrink-0 rounded-b-xl">
              <button type="button" onClick={close} className="px-4 py-2 rounded-lg text-sm bg-dark-700 hover:bg-dark-600 text-gray-300">Cancel</button>
              <button
                type="submit"
                disabled={submitting || !form.name || !form.contactPerson || !form.contactEmail}
                className="px-5 py-2 rounded-lg text-sm bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {submitting && <i className="ri-loader-4-line animate-spin" />}
                {submitting ? 'Registering…' : 'Register Partner'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] text-cyan-400 uppercase tracking-wider font-medium mb-2">{title}</p>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Grid({ cols, children }: { cols: 2 | 3; children: React.ReactNode }) {
  return <div className={`grid grid-cols-${cols === 3 ? '3' : '2'} gap-3`}>{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function DocUpload({
  label, accept, file, onChange,
}: {
  label: string;
  accept: string;
  file: File | undefined;
  onChange: (f: File | null) => void;
}) {
  return (
    <div className="bg-dark-900 border border-dark-700 rounded-lg p-2.5 flex items-center gap-2.5">
      <span className="w-7 h-7 rounded-md bg-cyan-500/15 text-cyan-300 flex items-center justify-center flex-shrink-0">
        <i className={`${file ? 'ri-file-check-line' : 'ri-attachment-2'} text-sm`} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-300 truncate">{label}</p>
        <p className="text-[10px] text-gray-500 truncate">{file ? file.name : 'No file selected'}</p>
      </div>
      <label className="px-2.5 py-1 rounded-md text-[11px] bg-dark-700 hover:bg-dark-600 text-gray-300 cursor-pointer whitespace-nowrap">
        {file ? 'Replace' : 'Upload'}
        <input type="file" accept={accept} className="hidden"
          onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      </label>
      {file && (
        <button type="button" onClick={() => onChange(null)} className="text-gray-500 hover:text-red-400 px-1" title="Remove">
          <i className="ri-close-line text-sm" />
        </button>
      )}
    </div>
  );
}
