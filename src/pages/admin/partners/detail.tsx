import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import AdminLayout from '../AdminLayout';
import { supabase, type Partner } from '@/lib/supabase';
import { confirmDialog } from '@/lib/notify';

type EditForm = {
  name: string;
  contact_person: string;
  contact_email: string;
  phone: string;
  gst_number: string;
  pan_number: string;
  address: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  commission_pct: number;
  discount_pct: number;
  bank_account_name: string;
  bank_account_number: string;
  bank_ifsc: string;
  bank_name: string;
  payment_mode: string;
  notes: string;
};

const statusColor: Record<string, string> = {
  pending:   'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  active:    'bg-green-500/15 text-green-400 border-green-500/30',
  suspended: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  rejected:  'bg-red-500/15 text-red-400 border-red-500/30',
};

export default function PartnerDetail() {
  const { partnerId } = useParams<{ partnerId: string }>();
  const navigate = useNavigate();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [resendError, setResendError] = useState<string | null>(null);

  // Counts of customers + active licenses, like the customer detail page does.
  const [customerCount, setCustomerCount] = useState(0);
  const [activeLicenseCount, setActiveLicenseCount] = useState(0);

  const [form, setForm] = useState<EditForm>({
    name: '', contact_person: '', contact_email: '', phone: '',
    gst_number: '', pan_number: '', address: '', city: '', state: '', postal_code: '',
    country: 'IN', commission_pct: 0, discount_pct: 40,
    bank_account_name: '', bank_account_number: '', bank_ifsc: '', bank_name: '',
    payment_mode: 'bank_transfer', notes: '',
  });

  useEffect(() => {
    if (!partnerId) return;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('partners').select('*').eq('id', partnerId).maybeSingle();
      if (error || !data) { setNotFound(true); setLoading(false); return; }
      const p = data as Partner;
      setPartner(p);
      setForm({
        name: p.name ?? '',
        contact_person: p.contact_person ?? '',
        contact_email: p.contact_email ?? '',
        phone: p.phone ?? '',
        gst_number: p.gst_number ?? '',
        pan_number: p.pan_number ?? '',
        address: p.address ?? '',
        city: p.city ?? '',
        state: p.state ?? '',
        postal_code: p.postal_code ?? '',
        country: p.country ?? 'IN',
        commission_pct: p.commission_pct ?? 0,
        discount_pct:   p.discount_pct   ?? 40,
        bank_account_name: p.bank_account_name ?? '',
        bank_account_number: p.bank_account_number ?? '',
        bank_ifsc: p.bank_ifsc ?? '',
        bank_name: p.bank_name ?? '',
        payment_mode: p.payment_mode ?? 'bank_transfer',
        notes: p.notes ?? '',
      });

      const [{ count: c1 }, { count: c2 }] = await Promise.all([
        supabase.from('organizations').select('id', { count: 'exact', head: true }).eq('partner_id', partnerId),
        supabase.from('licenses').select('id', { count: 'exact', head: true }).eq('partner_id', partnerId).eq('status', 'active'),
      ]);
      setCustomerCount(c1 ?? 0);
      setActiveLicenseCount(c2 ?? 0);
      setLoading(false);
    })();
  }, [partnerId]);

  const save = async () => {
    if (!partner) return;
    setEditBusy(true); setError(null);
    const { error } = await supabase
      .from('partners')
      .update({
        name: form.name.trim(),
        contact_person: form.contact_person.trim() || null,
        contact_email: form.contact_email.trim().toLowerCase(),
        phone: form.phone.trim() || null,
        gst_number: form.gst_number.trim() || null,
        pan_number: form.pan_number.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        postal_code: form.postal_code.trim() || null,
        country: form.country || 'IN',
        commission_pct: Number(form.commission_pct) || 0,
        discount_pct:   Math.max(0, Math.min(90, Number(form.discount_pct) || 0)),
        bank_account_name: form.bank_account_name.trim() || null,
        bank_account_number: form.bank_account_number.trim() || null,
        bank_ifsc: form.bank_ifsc.trim().toUpperCase() || null,
        bank_name: form.bank_name.trim() || null,
        payment_mode: form.payment_mode || null,
        notes: form.notes.trim() || null,
      })
      .eq('id', partner.id);
    setEditBusy(false);
    if (error) { setError(error.message); return; }
    setPartner({ ...partner, ...form } as Partner);
    setEditing(false);
  };

  const resetPassword = async () => {
    if (!partner) return;
    if (!await confirmDialog({ title: `Send password-reset email to ${partner.contact_email}?`, tone: 'danger' })) return;
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(partner.contact_email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) setError(`Reset failed: ${error.message}`);
    else setError('Reset email sent ✓');
  };

  const deletePartner = async () => {
    if (!partner) return;
    if (!await confirmDialog({ title: `Delete partner "${partner.name}"? This detaches all customers/licenses linked to them. Auth users + their data are NOT deleted.`, tone: 'danger' })) return;
    setError(null);
    const { error } = await supabase.from('partners').delete().eq('id', partner.id);
    if (error) { setError(`Delete failed: ${error.message}`); return; }
    navigate('/admin/partners', { replace: true });
  };

  const resendInvite = async () => {
    if (!partner) return;
    setResendStatus('sending'); setResendError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const jwt = sess.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-invite-partner`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          partner_id: partner.id,
          email: partner.contact_email,
          full_name: partner.contact_person,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `invite ${res.status}`);
      }
      setResendStatus('sent');
      setTimeout(() => setResendStatus('idle'), 5000);
    } catch (e) {
      setResendStatus('failed');
      setResendError((e as Error).message);
    }
  };

  if (loading) return <AdminLayout title="Partner"><div className="text-gray-500 text-sm">Loading…</div></AdminLayout>;
  if (notFound || !partner) {
    return (
      <AdminLayout title="Partner">
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-8 text-center">
          <p className="text-gray-400 text-sm">Partner not found.</p>
          <Link to="/admin/partners" className="text-cyan-400 hover:text-cyan-300 text-xs mt-2 inline-block">← Back to partners</Link>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={partner.name}>
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => navigate('/admin/partners')} className="text-xs text-gray-500 hover:text-cyan-400 flex items-center gap-1">
          <i className="ri-arrow-left-line" /> All partners
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={resendInvite}
            disabled={resendStatus === 'sending'}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium border flex items-center gap-1 disabled:opacity-50 ${
              resendStatus === 'sent' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' :
              resendStatus === 'failed' ? 'bg-red-500/15 text-red-400 border-red-500/30' :
              'bg-violet-500/10 text-violet-400 border-violet-500/20 hover:bg-violet-500/20'
            }`}
          >
            <i className={resendStatus === 'sending' ? 'ri-loader-4-line animate-spin text-xs' : 'ri-mail-send-line text-xs'} />
            {resendStatus === 'sent' ? 'Invite sent ✓' : resendStatus === 'failed' ? 'Send failed' : resendStatus === 'sending' ? 'Sending…' : 'Resend Invite'}
          </button>
          <button
            onClick={resetPassword}
            className="px-2.5 py-1 rounded-md bg-cyan-500/10 text-cyan-400 text-[11px] font-medium border border-cyan-500/20 hover:bg-cyan-500/20 flex items-center gap-1"
          >
            <i className="ri-lock-password-line text-xs" /> Reset Password
          </button>
          <button
            onClick={() => setEditing(true)}
            className="px-2.5 py-1 rounded-md bg-cyan-500/10 text-cyan-400 text-[11px] font-medium border border-cyan-500/20 hover:bg-cyan-500/20 flex items-center gap-1"
          >
            <i className="ri-edit-line text-xs" /> Edit
          </button>
          <button
            onClick={deletePartner}
            className="px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 text-[11px] font-medium border border-red-500/20 hover:bg-red-500/20 flex items-center gap-1"
          >
            <i className="ri-delete-bin-line text-xs" /> Delete
          </button>
          <span className={`px-2 py-0.5 text-[10px] rounded-md border ${statusColor[partner.status]} capitalize`}>{partner.status}</span>
        </div>
      </div>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      {resendError && <p className="mb-3 text-xs text-red-400">{resendError}</p>}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <Stat label="Customers" value={String(customerCount)} accent="text-emerald-400" />
        <Stat label="Active Licenses" value={String(activeLicenseCount)} accent="text-cyan-400" />
        <Stat label="Discount" value={`${partner.discount_pct ?? 40}%`} accent="text-emerald-400" />
        <Stat label="Commission" value={`${partner.commission_pct}%`} accent="text-amber-400" />
        <Stat label="Joined" value={new Date(partner.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })} accent="text-violet-400" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Profile" icon="ri-building-line">
          <Row k="Partner" v={partner.name} />
          <Row k="Contact Person" v={partner.contact_person ?? '—'} />
          <Row k="Email" v={partner.contact_email} />
          <Row k="Phone" v={partner.phone ?? '—'} />
          <Row k="GST Number" v={partner.gst_number ?? '—'} />
          <Row k="PAN Number" v={partner.pan_number ?? '—'} />
          <Row k="Address" v={[partner.address, partner.city, partner.state, partner.postal_code].filter(Boolean).join(', ') || '—'} />
          <Row k="Country" v={partner.country ?? '—'} />
        </Section>

        <Section title="Payment" icon="ri-bank-line">
          <Row k="Payment Mode" v={partner.payment_mode ?? '—'} />
          <Row k="Account Holder" v={partner.bank_account_name ?? '—'} />
          <Row k="Bank Name" v={partner.bank_name ?? '—'} />
          <Row k="Account Number" v={partner.bank_account_number ? '••••' + partner.bank_account_number.slice(-4) : '—'} />
          <Row k="IFSC" v={partner.bank_ifsc ?? '—'} />
          <Row k="Notes" v={partner.notes ?? '—'} />
        </Section>

        <Section title="Documents" icon="ri-attachment-2">
          <DocLink label="GST Certificate" path={partner.gst_certificate_url} partnerId={partner.id} />
          <DocLink label="Authorization Letter" path={partner.authorization_letter_url} partnerId={partner.id} />
          <DocLink label="Cancelled Cheque" path={partner.cancelled_cheque_url} partnerId={partner.id} />
        </Section>
      </div>

      {editing && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4 overflow-y-auto" onClick={() => !editBusy && setEditing(false)}>
          <div className="max-w-3xl w-full bg-dark-800 border border-dark-700 rounded-xl my-6" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">Edit Partner</h3>
              <button onClick={() => setEditing(false)} disabled={editBusy} className="text-gray-400 hover:text-white">
                <i className="ri-close-line text-lg" />
              </button>
            </div>
            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[70vh] overflow-y-auto">
              <Field label="Partner Name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
              <Field label="Contact Person" value={form.contact_person} onChange={(v) => setForm({ ...form, contact_person: v })} />
              <Field label="Email *" value={form.contact_email} onChange={(v) => setForm({ ...form, contact_email: v })} />
              <Field label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
              <Field label="GST Number" value={form.gst_number} onChange={(v) => setForm({ ...form, gst_number: v.toUpperCase() })} />
              <Field label="PAN Number" value={form.pan_number} onChange={(v) => setForm({ ...form, pan_number: v.toUpperCase() })} />
              <div className="col-span-1 md:col-span-2">
                <Field label="Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
              </div>
              <Field label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
              <Field label="State" value={form.state} onChange={(v) => setForm({ ...form, state: v })} />
              <Field label="PIN Code" value={form.postal_code} onChange={(v) => setForm({ ...form, postal_code: v })} />
              <Field label="Country (ISO2)" value={form.country} onChange={(v) => setForm({ ...form, country: v.toUpperCase() })} />
              <Field label="Commission % (paid on renewals)" value={String(form.commission_pct)} onChange={(v) => setForm({ ...form, commission_pct: Number(v) || 0 })} />
              <Field
                label="Discount % off list price (0–90)"
                value={String(form.discount_pct)}
                onChange={(v) => {
                  const n = Number(v);
                  setForm({ ...form, discount_pct: Number.isFinite(n) ? Math.max(0, Math.min(90, n)) : 40 });
                }}
              />
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">Payment Mode</label>
                <select
                  value={form.payment_mode}
                  onChange={(e) => setForm({ ...form, payment_mode: e.target.value })}
                  className="w-full bg-dark-900 border border-dark-700 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
                >
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="upi">UPI</option>
                  <option value="cheque">Cheque/DD</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <Field label="Account Holder" value={form.bank_account_name} onChange={(v) => setForm({ ...form, bank_account_name: v })} />
              <Field label="Bank Name" value={form.bank_name} onChange={(v) => setForm({ ...form, bank_name: v })} />
              <Field label="Account Number" value={form.bank_account_number} onChange={(v) => setForm({ ...form, bank_account_number: v.replace(/\D/g, '') })} />
              <Field label="IFSC" value={form.bank_ifsc} onChange={(v) => setForm({ ...form, bank_ifsc: v.toUpperCase() })} />
              <div className="col-span-1 md:col-span-2">
                <Field label="Notes (internal)" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-dark-700 flex items-center justify-end gap-2">
              <button onClick={() => setEditing(false)} disabled={editBusy} className="px-3 py-1.5 rounded-md bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs">Cancel</button>
              <button onClick={save} disabled={editBusy} className="px-4 py-1.5 rounded-md bg-cyan-500 hover:bg-cyan-400 text-dark-950 text-xs font-medium disabled:opacity-60">
                {editBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <p className="text-[10px] uppercase text-gray-500 tracking-wider">{label}</p>
      <p className={`text-lg font-bold ${accent} capitalize mt-1`}>{value}</p>
    </div>
  );
}
function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-dark-700 flex items-center gap-2">
        <i className={`${icon} text-cyan-400`} /><h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      <div className="p-5 space-y-2.5 text-xs">{children}</div>
    </div>
  );
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-dark-700/50 last:border-0 pb-2 last:pb-0">
      <span className="text-gray-500">{k}</span>
      <span className="text-white text-right max-w-[60%] break-words">{v}</span>
    </div>
  );
}
function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-[11px] text-gray-500 block mb-1">{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full bg-dark-900 border border-dark-700 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50" />
    </div>
  );
}

function DocLink({ label, path, partnerId }: { label: string; path: string | null; partnerId: string }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    (async () => {
      const { data } = await supabase.storage.from('partner-documents').createSignedUrl(path, 60 * 10);
      setSignedUrl(data?.signedUrl ?? null);
    })();
  }, [path, partnerId]);
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dark-700/50 last:border-0 pb-2 last:pb-0">
      <span className="text-gray-500">{label}</span>
      {!path ? (
        <span className="text-gray-600 text-[11px]">Not uploaded</span>
      ) : signedUrl ? (
        <a href={signedUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:text-cyan-300 text-[11px] flex items-center gap-1">
          <i className="ri-external-link-line" /> View
        </a>
      ) : (
        <span className="text-gray-500 text-[11px]">…</span>
      )}
    </div>
  );
}
