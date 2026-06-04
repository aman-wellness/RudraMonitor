import { useEffect, useState } from 'react';
import { supabase, type Plan } from '@/lib/supabase';
import { decodeGstin, GSTIN_REGEX } from '@/lib/gst';
import CountryStatePicker from '@/components/forms/CountryStatePicker';
import PhoneInput from '@/components/forms/PhoneInput';

type Issued = { organization_id: string; license_id: string; license_key: string; expires_at: string };

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Super-admin: lets you assign the org to a specific partner (or none). Partners: ignored. */
  showPartnerPicker?: boolean;
  partners?: { id: string; name: string }[];
}

const inputCls =
  'w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500';

export default function NewCustomerModal({ open, onClose, onCreated, showPartnerPicker, partners }: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [inviteStatus, setInviteStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Form state — flat object keeps render simple.
  const [form, setForm] = useState({
    orgName: '',
    contactPerson: '',
    ownerEmail: '',
    phone: '',
    gstNumber: '',
    panNumber: '',
    address: '',
    country: 'IN',
    city: '',
    state: '',
    postalCode: '',
    planId: '',
    seatOverride: '',
    partnerId: '',
    notes: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((p) => ({ ...p, [k]: v }));

  const [gstLookupBusy, setGstLookupBusy] = useState(false);
  const [gstLookupErr, setGstLookupErr] = useState<string | null>(null);

  // Fired when the user types/pastes a GST. We do an immediate structural decode
  // (state code → state name, GSTIN[2..12] → PAN) so they see autofill before any
  // network call. The "Lookup" button below kicks off the full third-party fetch.
  const onGstChange = (raw: string) => {
    const next = raw.toUpperCase();
    set('gstNumber', next);
    const decoded = decodeGstin(next);
    if (decoded.valid) {
      setForm((p) => ({
        ...p,
        gstNumber: next,
        country: 'IN', // GSTIN ⇒ Indian entity
        state: decoded.stateName ?? p.state,
        panNumber: decoded.pan ?? p.panNumber,
      }));
    }
  };

  const lookupGst = async () => {
    if (!GSTIN_REGEX.test(form.gstNumber)) {
      setGstLookupErr('Invalid GSTIN format');
      return;
    }
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
        orgName: d.legal_name || d.trade_name || p.orgName,
        address: d.address ?? p.address,
        city: d.city ?? p.city,
        state: d.state ?? p.state,
        postalCode: d.pincode ?? p.postalCode,
        panNumber: d.pan ?? p.panNumber,
        country: 'IN',
      }));
    } catch (e) {
      setGstLookupErr((e as Error).message);
    } finally {
      setGstLookupBusy(false);
    }
  };

  // Partner discount % — when a partner is the one filling this form (i.e. the
  // partner portal, where showPartnerPicker=false), we replace the plan-level
  // `partner_price_inr` with `list × (1 - discount/100)` so super_admin's
  // per-partner overrides take effect.
  const [partnerDiscount, setPartnerDiscount] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const { data } = await supabase.from('plans').select('*').eq('is_active', true).order('seat_count');
      setPlans((data as Plan[]) ?? []);
      if (data?.[0]) set('planId', (data[0] as Plan).id);

      // Partner side only — fetch the current partner's discount %.
      if (!showPartnerPicker) {
        const { data: u } = await supabase.auth.getUser();
        if (u.user) {
          const { data: au } = await supabase
            .from('app_users')
            .select('partner_id')
            .eq('user_id', u.user.id)
            .maybeSingle();
          if (au?.partner_id) {
            const { data: p } = await supabase
              .from('partners')
              .select('discount_pct')
              .eq('id', au.partner_id)
              .maybeSingle();
            setPartnerDiscount(p?.discount_pct ?? 40);
          }
        }
      }
    })();
  }, [open, showPartnerPicker]);

  const reset = () => {
    setForm({
      orgName: '', contactPerson: '', ownerEmail: '', phone: '',
      gstNumber: '', panNumber: '', address: '', country: 'IN', city: '', state: '', postalCode: '',
      planId: plans[0]?.id ?? '', seatOverride: '', partnerId: '', notes: '',
    });
    setIssued(null); setError(null); setCopied(false); setInviteStatus('idle'); setInviteError(null);
    setGstLookupErr(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setError(null);
    const { data, error } = await supabase.rpc('create_customer_with_license', {
      p_org_name: form.orgName.trim(),
      p_plan_id: form.planId,
      p_seat_count: form.seatOverride ? parseInt(form.seatOverride, 10) : null,
      p_owner_email: form.ownerEmail.trim() || null,
      p_partner_id: form.partnerId || null,
      p_notes: form.notes.trim() || null,
      p_contact_person: form.contactPerson.trim() || null,
      p_gst_number: form.gstNumber.trim() || null,
      p_pan_number: form.panNumber.trim() || null,
      p_address: form.address.trim() || null,
      p_city: form.city.trim() || null,
      p_state: form.state.trim() || null,
      p_postal_code: form.postalCode.trim() || null,
      p_phone: form.phone.trim() || null,
    });
    // Persist country separately (not part of the RPC signature) so we don't have
    // to bump the function for one new optional column.
    if (!error && (Array.isArray(data) ? data[0] : data)?.organization_id && form.country) {
      const orgId = (Array.isArray(data) ? data[0] : data).organization_id;
      await supabase.from('organizations').update({ country: form.country }).eq('id', orgId);
    }
    setSubmitting(false);
    if (error) { setError(error.message); return; }
    const row = (Array.isArray(data) ? data[0] : data) as Issued;
    setIssued(row);
    onCreated();

    // Fire-and-forget owner invite. We surface success/fail in the next step UI but don't
    // gate the license display on it — license issuance already succeeded.
    if (form.ownerEmail.trim()) {
      setInviteStatus('sending');
      try {
        const { data: sess } = await supabase.auth.getSession();
        const jwt = sess.session?.access_token;
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-invite-customer-owner`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({
            org_id: row.organization_id,
            email: form.ownerEmail.trim(),
            full_name: form.contactPerson.trim() || null,
            role: 'admin',
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
    }
  };

  const copy = async () => {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.license_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const close = () => { reset(); onClose(); };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4 overflow-y-auto" onClick={close}>
      <div className="max-w-5xl w-full bg-dark-800 border border-dark-700 rounded-xl my-6 flex flex-col max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-dark-700 flex items-center justify-between bg-dark-800 rounded-t-xl flex-shrink-0">
          <div>
            <h2 className="text-white font-semibold text-base">{issued ? 'Customer Registered' : 'New Customer'}</h2>
            {!issued && <p className="text-[11px] text-gray-500 mt-0.5">Fill in the customer details to register and issue a license</p>}
          </div>
          <button onClick={close} className="text-gray-400 hover:text-white p-1"><i className="ri-close-line text-xl" /></button>
        </div>

        {issued ? (
          <div className="p-6 space-y-4 overflow-y-auto">
            <p className="text-sm text-gray-400">
              Customer registered. Share this license key with them — they&apos;ll enter it during agent setup.
            </p>
            <div className="bg-dark-900 border border-dark-700 rounded-lg p-3 font-mono text-xs text-cyan-300 break-all">
              {issued.license_key}
            </div>
            <p className="text-[11px] text-gray-500">
              Expires: {new Date(issued.expires_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
            </p>
            {form.ownerEmail.trim() && (
              <div className={`text-xs rounded-lg border px-3 py-2 ${
                inviteStatus === 'sent'   ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' :
                inviteStatus === 'failed' ? 'bg-red-500/10 border-red-500/30 text-red-300' :
                                            'bg-cyan-500/10 border-cyan-500/30 text-cyan-300'
              }`}>
                {inviteStatus === 'sending' && <>📧 Sending portal invite to <strong>{form.ownerEmail}</strong>…</>}
                {inviteStatus === 'sent' && <>✓ Portal invite emailed to <strong>{form.ownerEmail}</strong>. They&apos;ll get a magic link to set their password and log in.</>}
                {inviteStatus === 'failed' && <>✗ Invite failed: {inviteError}. License is still issued — you can resend later from the customer detail page.</>}
                {inviteStatus === 'idle' && <>📧 Portal invite queued for <strong>{form.ownerEmail}</strong>.</>}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={copy} className="flex-1 px-3 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 text-sm font-medium">
                {copied ? '✓ Copied' : 'Copy License Key'}
              </button>
              <button onClick={close} className="px-3 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-sm">Done</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col flex-1 overflow-hidden">
            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {error && <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>}

              {/* Hero: Organization name (full width, prominent) */}
              <div>
                <label className="text-[11px] text-cyan-400 uppercase tracking-wider font-medium block mb-1.5">Organization Name *</label>
                <input required value={form.orgName} onChange={(e) => set('orgName', e.target.value)}
                  className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2.5 text-base text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
                  placeholder="Enter organization name" />
              </div>

              {/* Two-column layout for the rest */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* LEFT COLUMN */}
                <div className="space-y-5">
                  <Section title="Contact">
                    <Grid cols={2}>
                      <Field label="Account Person">
                        <input value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} className={inputCls} placeholder="Enter contact person name" />
                      </Field>
                      <Field label="Phone">
                        <PhoneInput value={form.phone} onChange={(v) => set('phone', v)} defaultCountry={form.country || 'IN'} />
                      </Field>
                    </Grid>
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

                  <Section title="Portal Access">
                    <Field label="Owner Email (will receive portal invite)">
                      <input type="email" value={form.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} className={inputCls} placeholder="Enter email address" />
                    </Field>
                    <p className="text-[11px] text-gray-500 -mt-1">A magic-link invite is emailed; the user clicks it to set their password and access the dashboard.</p>
                  </Section>
                </div>

                {/* RIGHT COLUMN */}
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

                  <Section title="Plan & Billing">
                    <Grid cols={2}>
                      <Field label="Plan *">
                        <select required value={form.planId} onChange={(e) => set('planId', e.target.value)} className={inputCls}>
                          {plans.map((p) => {
                            const list = `₹${p.price_inr.toLocaleString('en-IN')}`;
                            // Discount-aware wholesale price for partners. Falls
                            // back to the plan-level partner_price_inr if no
                            // partner discount is known (super-admin view).
                            const effectivePartnerPrice = partnerDiscount != null
                              ? Math.round(Number(p.price_inr) * (1 - partnerDiscount / 100) * 100) / 100
                              : Number(p.partner_price_inr);
                            const partnerLabel = `₹${effectivePartnerPrice.toLocaleString('en-IN')}`;
                            const label = showPartnerPicker
                              ? `${p.name} — ${list} list / ${partnerLabel} partner / ${p.billing_cycle}`
                              : `${p.name} — ${partnerLabel} / ${p.billing_cycle}`;
                            return <option key={p.id} value={p.id}>{label}</option>;
                          })}
                        </select>
                        {!showPartnerPicker && partnerDiscount != null && (
                          <p className="text-[11px] text-violet-300/70 mt-1">
                            Your wholesale rate = list × ({100 - partnerDiscount}% of list). Wellness Extract bills you this amount; you charge the customer whatever you like.
                          </p>
                        )}
                      </Field>
                      <Field label="Seat Override">
                        <input type="number" min={1} value={form.seatOverride} onChange={(e) => set('seatOverride', e.target.value)} className={inputCls} placeholder="Defaults to plan seats" />
                      </Field>
                    </Grid>
                    {showPartnerPicker && (
                      <Field label="Assign to Partner">
                        <select value={form.partnerId} onChange={(e) => set('partnerId', e.target.value)} className={inputCls}>
                          <option value="">— Direct customer —</option>
                          {(partners ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </Field>
                    )}
                    <Field label="Notes (internal)">
                      <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className={inputCls} />
                    </Field>
                  </Section>
                </div>
              </div>
            </div>

            {/* Sticky footer with submit */}
            <div className="px-6 py-4 border-t border-dark-700 bg-dark-800/95 backdrop-blur flex items-center justify-end gap-2 flex-shrink-0 rounded-b-xl">
              <button type="button" onClick={close} className="px-4 py-2 rounded-lg text-sm bg-dark-700 hover:bg-dark-600 text-gray-300">
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !form.orgName || !form.planId}
                className="px-5 py-2 rounded-lg text-sm bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium disabled:opacity-50 flex items-center gap-2"
              >
                {submitting && <i className="ri-loader-4-line animate-spin" />}
                {submitting ? 'Creating…' : 'Register & Issue License'}
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
  // `min-w-0` on each child cell stops <input>'s intrinsic min width from
  // forcing the cell wider than its 1fr track and bleeding into neighbours.
  return <div className={`grid grid-cols-${cols === 3 ? '3' : '2'} gap-3 [&>*]:min-w-0`}>{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</span>
      <div className="mt-1 min-w-0">{children}</div>
    </label>
  );
}
