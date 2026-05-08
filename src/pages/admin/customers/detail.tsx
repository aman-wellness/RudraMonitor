import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import AdminLayout from '../AdminLayout';
import { supabase, type Organization } from '@/lib/supabase';
import CountryStatePicker from '@/components/forms/CountryStatePicker';
import PhoneInput from '@/components/forms/PhoneInput';
import { decodeGstin, GSTIN_REGEX } from '@/lib/gst';

type LicenseRow = {
  id: string;
  license_key: string;
  status: 'active' | 'suspended' | 'expired' | 'revoked' | 'pending_payment';
  seat_count: number;
  issued_at: string;
  expires_at: string;
  plan: { name: string } | null;
};

type InvoiceRow = {
  id: string;
  invoice_number: string;
  total_amount: number;
  status: string;
  invoice_date: string;
};

type AgentRow = {
  id: string;
  agent_name: string;
  machine_name: string | null;
  os_type: string | null;
  status: string | null;
  last_active: string | null;
};

type UserRow = {
  member_id: string;
  user_id: string | null;
  email: string | null;
  full_name: string | null;
  role: string;
  created_at: string;
};

type ProfileForm = {
  name: string;
  contact_person: string;
  gst_number: string;
  pan_number: string;
  address: string;
  country: string;
  city: string;
  state: string;
  postal_code: string;
  phone: string;
  license_count: number;
};

type CustomerView = Organization & {
  partner: { id: string; name: string } | null;
};

export default function CustomerDetail() {
  const { customerId } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const [org, setOrg] = useState<CustomerView | null>(null);
  const [licenses, setLicenses] = useState<LicenseRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileForm>({
    name: '', contact_person: '', gst_number: '', pan_number: '',
    address: '', country: 'IN', city: '', state: '', postal_code: '', phone: '', license_count: 0,
  });
  const [editGstBusy, setEditGstBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [resetState, setResetState] = useState<{ email: string; status: 'sending' | 'sent' | 'error'; msg?: string } | null>(null);

  const [usersError, setUsersError] = useState<string | null>(null);
  const loadUsers = async (orgId: string) => {
    const { data, error } = await supabase.rpc('admin_get_customer_users', { p_org_id: orgId });
    if (error) {
      console.error('[admin_get_customer_users]', error);
      setUsersError(error.message);
      setUsers([]);
      return;
    }
    setUsersError(null);
    setUsers((data as UserRow[]) ?? []);
  };

  const saveProfile = async () => {
    if (!org) return;
    setProfileBusy(true);
    const { error } = await supabase
      .from('organizations')
      .update({
        name: profileForm.name.trim() || org.name,
        contact_person: profileForm.contact_person.trim() || null,
        gst_number: profileForm.gst_number.trim() || null,
        pan_number: profileForm.pan_number.trim() || null,
        address: profileForm.address.trim() || null,
        country: profileForm.country || 'IN',
        city: profileForm.city.trim() || null,
        state: profileForm.state.trim() || null,
        postal_code: profileForm.postal_code.trim() || null,
        phone: profileForm.phone.trim() || null,
        license_count: Math.max(0, Math.floor(profileForm.license_count || 0)),
      })
      .eq('id', org.id);
    setProfileBusy(false);
    if (error) {
      alert(`Update failed: ${error.message}`);
      return;
    }
    setOrg({ ...org, ...profileForm });
    setEditing(false);
  };

  const sendPasswordReset = async (email: string) => {
    setResetState({ email, status: 'sending' });
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    if (error) setResetState({ email, status: 'error', msg: error.message });
    else setResetState({ email, status: 'sent' });
    setTimeout(() => setResetState(null), 4000);
  };

  useEffect(() => {
    if (!customerId) return;
    (async () => {
      setLoading(true);
      const { data: orgRow, error } = await supabase
        .from('organizations')
        .select('*, partner:partners(id, name)')
        .eq('id', customerId)
        .maybeSingle();

      if (error || !orgRow) { setNotFound(true); setLoading(false); return; }
      setOrg(orgRow as CustomerView);
      setProfileForm({
        name: orgRow.name ?? '',
        contact_person: orgRow.contact_person ?? '',
        gst_number: orgRow.gst_number ?? '',
        pan_number: orgRow.pan_number ?? '',
        address: orgRow.address ?? '',
        country: orgRow.country ?? 'IN',
        city: orgRow.city ?? '',
        state: orgRow.state ?? '',
        postal_code: orgRow.postal_code ?? '',
        phone: orgRow.phone ?? '',
        license_count: orgRow.license_count ?? 0,
      });
      void loadUsers(customerId);

      const [licRes, agentRes, invRes] = await Promise.all([
        supabase.from('licenses')
          .select('id, license_key, status, seat_count, issued_at, expires_at, plan:plans(name)')
          .eq('organization_id', customerId)
          .order('issued_at', { ascending: false }),
        supabase.from('agents')
          .select('id, agent_name, machine_name, os_type, status, last_active')
          .eq('org_id', customerId)
          .order('created_at', { ascending: false }),
        supabase.from('invoices')
          .select('id, invoice_number, total_amount, status, invoice_date')
          .eq('organization_id', customerId)
          .order('invoice_date', { ascending: false })
          .limit(10),
      ]);

      setLicenses((licRes.data as unknown as LicenseRow[]) ?? []);
      setAgents((agentRes.data as AgentRow[]) ?? []);
      setInvoices((invRes.data as InvoiceRow[]) ?? []);
      setLoading(false);
    })();
  }, [customerId]);

  if (loading) {
    return <AdminLayout title="Customer"><div className="text-gray-500 text-sm">Loading…</div></AdminLayout>;
  }
  if (notFound || !org) {
    return (
      <AdminLayout title="Customer">
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-8 text-center">
          <p className="text-gray-400 text-sm">Customer not found.</p>
          <Link to="/admin/customers" className="text-cyan-400 hover:text-cyan-300 text-xs mt-2 inline-block">← Back to customers</Link>
        </div>
      </AdminLayout>
    );
  }

  const activeSeats = licenses.filter((l) => l.status === 'active').reduce((s, l) => s + l.seat_count, 0);
  const usedSeats = agents.length;
  const totalRevenue = invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + Number(i.total_amount || 0), 0);

  return (
    <AdminLayout title={org.name}>
      {/* Top breadcrumb + actions */}
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => navigate('/admin/customers')} className="text-xs text-gray-500 hover:text-cyan-400 flex items-center gap-1">
          <i className="ri-arrow-left-line" /> All customers
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditing(true)}
            className="px-2.5 py-1 rounded-md bg-cyan-500/10 text-cyan-400 text-[11px] font-medium border border-cyan-500/20 hover:bg-cyan-500/20 transition-colors flex items-center gap-1"
          >
            <i className="ri-edit-line text-xs" /> Edit Customer
          </button>
          <StatusPill status={org.subscription_status} />
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Stat label="Active Seats" value={`${usedSeats} / ${activeSeats || org.license_count}`} accent="text-emerald-400" />
        <Stat label="Active Licenses" value={String(licenses.filter((l) => l.status === 'active').length)} accent="text-cyan-400" />
        <Stat label="Plan" value={org.subscription_type ?? 'trial'} accent="text-amber-400" />
        <Stat label="Revenue (paid)" value={`₹ ${totalRevenue.toLocaleString('en-IN')}`} accent="text-violet-400" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Org profile */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <i className="ri-building-line text-cyan-400" /> Profile
          </h3>
          <div className="space-y-2.5 text-xs">
            <Row k="Organization" v={org.name} />
            <Row k="Account Person" v={org.contact_person ?? '—'} />
            <Row k="Partner" v={org.partner ? <Link to={`/admin/partners`} className="text-cyan-400 hover:text-cyan-300">{org.partner.name}</Link> : <span className="text-gray-600">— direct —</span>} />
            <Row k="GST Number" v={org.gst_number ?? '—'} />
            <Row k="PAN Number" v={org.pan_number ?? '—'} />
            <Row k="Address" v={[org.address, org.city, org.state, org.postal_code].filter(Boolean).join(', ') || '—'} />
            <Row k="Phone" v={org.phone ?? '—'} />
            <Row k="Created" v={new Date(org.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} />
            <Row k="Trial ends" v={org.trial_ends_at ? new Date(org.trial_ends_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'} />
          </div>
        </div>

        {/* License key + utilisation */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <i className="ri-key-2-line text-emerald-400" /> Org License Key
          </h3>
          <div className="bg-dark-900 border border-dark-700 rounded-lg p-3 mb-3">
            <code className="text-xs text-emerald-400 font-mono break-all block">{org.license_key}</code>
          </div>
          <div className="text-[11px] text-gray-500 leading-relaxed">
            This is the org-wide bootstrap key the desktop agent uses on first launch to enroll.
            Seat usage: <span className="text-white font-medium">{usedSeats}</span> / {org.license_count} ({org.license_count > 0 ? Math.round((usedSeats / org.license_count) * 100) : 0}%)
          </div>
          <div className="w-full bg-dark-700 rounded-full h-1.5 mt-2">
            <div className="bg-emerald-500 h-1.5 rounded-full" style={{ width: `${Math.min(100, org.license_count > 0 ? (usedSeats / org.license_count) * 100 : 0)}%` }} />
          </div>
        </div>
      </div>

      {/* Licenses */}
      <Section title="Licenses Issued" icon="ri-key-2-line">
        {licenses.length === 0 ? (
          <Empty msg="No licenses issued to this customer yet." />
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase text-gray-500 bg-dark-900/50">
              <tr>
                <Th>License Key</Th><Th>Plan</Th><Th>Seats</Th><Th>Status</Th><Th>Issued</Th><Th>Expires</Th><Th>Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-700">
              {licenses.map((l) => (
                <tr key={l.id} className="hover:bg-dark-700/30">
                  <td className="px-4 py-2 font-mono text-emerald-400 truncate max-w-[180px]">{l.license_key}</td>
                  <td className="px-4 py-2 text-gray-300">{l.plan?.name ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-300">{l.seat_count}</td>
                  <td className="px-4 py-2"><StatusPill status={l.status} /></td>
                  <td className="px-4 py-2 text-gray-500">{new Date(l.issued_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                  <td className="px-4 py-2 text-gray-500">{new Date(l.expires_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                  <td className="px-4 py-2">
                    {l.status === 'pending_payment' ? (
                      <button
                        onClick={async () => {
                          if (!confirm('Confirm partner payment received and activate this license?')) return;
                          const { error: actErr } = await supabase.rpc('activate_pending_license', { p_license_id: l.id });
                          if (actErr) alert(`Activation failed: ${actErr.message}`);
                          else if (customerId) {
                            const { data: licRes } = await supabase.from('licenses')
                              .select('id, license_key, status, seat_count, issued_at, expires_at, plan:plans(name)')
                              .eq('organization_id', customerId)
                              .order('issued_at', { ascending: false });
                            setLicenses((licRes as unknown as LicenseRow[]) ?? []);
                          }
                        }}
                        className="px-2.5 py-1 rounded-md text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25"
                      >
                        ✓ Activate (payment received)
                      </button>
                    ) : (
                      <span className="text-[10px] text-gray-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Agents */}
      <Section title={`Agents (${agents.length})`} icon="ri-computer-line">
        {agents.length === 0 ? (
          <Empty msg="No agents enrolled yet." />
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase text-gray-500 bg-dark-900/50">
              <tr>
                <Th>Agent</Th><Th>Machine</Th><Th>OS</Th><Th>Status</Th><Th>Last active</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-700">
              {agents.map((a) => (
                <tr key={a.id} className="hover:bg-dark-700/30">
                  <td className="px-4 py-2 text-white">{a.agent_name}</td>
                  <td className="px-4 py-2 text-gray-400">{a.machine_name ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-400">{a.os_type ?? '—'}</td>
                  <td className="px-4 py-2"><StatusPill status={a.status ?? 'offline'} /></td>
                  <td className="px-4 py-2 text-gray-500">{a.last_active ? new Date(a.last_active).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Users (admins, managers, viewers) */}
      <Section title={`Users (${users.length})`} icon="ri-team-line">
        {usersError ? (
          <div className="px-5 py-4 text-xs text-red-400 bg-red-500/5 border-b border-red-500/20">
            <strong>Failed to load users:</strong> {usersError}
          </div>
        ) : null}
        {users.length === 0 ? (
          <Empty msg={usersError ? 'See error above.' : 'No users for this customer yet.'} />
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase text-gray-500 bg-dark-900/50">
              <tr>
                <Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Joined</Th><Th>Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-700">
              {users.map((u) => {
                const sending = resetState?.email === u.email && resetState.status === 'sending';
                const sent    = resetState?.email === u.email && resetState.status === 'sent';
                const errored = resetState?.email === u.email && resetState.status === 'error';
                return (
                  <tr key={u.member_id} className="hover:bg-dark-700/30">
                    <td className="px-4 py-2 text-white">{u.full_name ?? <span className="text-gray-600">—</span>}</td>
                    <td className="px-4 py-2 text-gray-300">{u.email ?? <span className="text-gray-600">—</span>}</td>
                    <td className="px-4 py-2"><RolePill role={u.role} /></td>
                    <td className="px-4 py-2 text-gray-500">{new Date(u.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                    <td className="px-4 py-2">
                      {u.email ? (
                        <button
                          onClick={() => sendPasswordReset(u.email!)}
                          disabled={sending}
                          className={`px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                            sent ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' :
                            errored ? 'bg-red-500/15 text-red-400 border-red-500/30' :
                            'bg-dark-700 text-gray-400 border-dark-600 hover:text-cyan-400 hover:border-cyan-500/30'
                          } disabled:opacity-50`}
                        >
                          {sending ? 'Sending…' : sent ? 'Email sent ✓' : errored ? 'Failed' : 'Reset Password'}
                        </button>
                      ) : (
                        <span className="text-[10px] text-gray-600">— pending invite —</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {resetState?.status === 'error' && resetState.msg && (
          <div className="px-5 py-2 text-[11px] text-red-400 border-t border-dark-700">{resetState.msg}</div>
        )}
      </Section>

      {/* Invoices */}
      <Section title="Recent Invoices" icon="ri-bill-line">
        {invoices.length === 0 ? (
          <Empty msg="No invoices billed yet." />
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase text-gray-500 bg-dark-900/50">
              <tr>
                <Th>Number</Th><Th>Date</Th><Th>Amount</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-700">
              {invoices.map((i) => (
                <tr key={i.id} className="hover:bg-dark-700/30">
                  <td className="px-4 py-2 font-mono text-cyan-400">{i.invoice_number}</td>
                  <td className="px-4 py-2 text-gray-500">{new Date(i.invoice_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-4 py-2 text-white">₹ {Number(i.total_amount).toLocaleString('en-IN')}</td>
                  <td className="px-4 py-2"><StatusPill status={i.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Edit Customer modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center px-4" onClick={() => !profileBusy && setEditing(false)}>
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-white">Edit Customer</h3>
              <button onClick={() => setEditing(false)} disabled={profileBusy} className="text-gray-500 hover:text-white">
                <i className="ri-close-line text-lg" />
              </button>
            </div>
            <div className="space-y-3">
              <PlainField label="Organization Name" value={profileForm.name} onChange={(v) => setProfileForm((p) => ({ ...p, name: v }))} />
              <PlainField label="Account Person" value={profileForm.contact_person} onChange={(v) => setProfileForm((p) => ({ ...p, contact_person: v }))} />

              <div>
                <label className="text-[11px] text-gray-500 block mb-1">GST Number</label>
                <div className="flex gap-2">
                  <input
                    value={profileForm.gst_number}
                    onChange={(e) => {
                      const next = e.target.value.toUpperCase();
                      const decoded = decodeGstin(next);
                      setProfileForm((p) => ({
                        ...p,
                        gst_number: next,
                        ...(decoded.valid ? { country: 'IN', state: decoded.stateName ?? p.state, pan_number: decoded.pan ?? p.pan_number } : {}),
                      }));
                    }}
                    maxLength={15}
                    placeholder="22AAAAA0000A1Z5"
                    className="flex-1 bg-dark-900 border border-dark-700 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      if (!GSTIN_REGEX.test(profileForm.gst_number)) return;
                      setEditGstBusy(true);
                      try {
                        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gst-lookup`;
                        const res = await fetch(url, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
                          body: JSON.stringify({ gstin: profileForm.gst_number }),
                        });
                        const j = await res.json();
                        if (res.ok && j.ok && j.data) {
                          const d = j.data;
                          setProfileForm((p) => ({
                            ...p,
                            name: d.legal_name || d.trade_name || p.name,
                            address: d.address ?? p.address,
                            city: d.city ?? p.city,
                            state: d.state ?? p.state,
                            postal_code: d.pincode ?? p.postal_code,
                            pan_number: d.pan ?? p.pan_number,
                            country: 'IN',
                          }));
                        }
                      } finally { setEditGstBusy(false); }
                    }}
                    disabled={editGstBusy || !GSTIN_REGEX.test(profileForm.gst_number)}
                    className="px-2.5 rounded-md text-[11px] whitespace-nowrap bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-40"
                  >
                    {editGstBusy ? '…' : 'Auto-fill'}
                  </button>
                </div>
              </div>

              <PlainField label="PAN Number" value={profileForm.pan_number} onChange={(v) => setProfileForm((p) => ({ ...p, pan_number: v.toUpperCase() }))} />
              <PlainField label="Street / Building" value={profileForm.address} onChange={(v) => setProfileForm((p) => ({ ...p, address: v }))} />

              <CountryStatePicker
                country={profileForm.country}
                state={profileForm.state}
                city={profileForm.city}
                onChange={({ country, state, city }) => setProfileForm((p) => ({ ...p, country, state, city }))}
                inputClassName="w-full bg-dark-900 border border-dark-700 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
              />

              <PlainField label="PIN / Postal Code" value={profileForm.postal_code} onChange={(v) => setProfileForm((p) => ({ ...p, postal_code: v }))} />
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">Phone</label>
                <PhoneInput value={profileForm.phone} onChange={(v) => setProfileForm((p) => ({ ...p, phone: v }))} defaultCountry={profileForm.country || 'IN'} />
              </div>

              <div>
                <label className="text-[11px] text-gray-500 block mb-1">License Count (seats)</label>
                <input
                  type="number"
                  min={0}
                  value={profileForm.license_count}
                  onChange={(e) => setProfileForm((p) => ({ ...p, license_count: Number(e.target.value) }))}
                  className="w-full bg-dark-900 border border-dark-700 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 mt-5">
              <button
                onClick={() => setEditing(false)}
                disabled={profileBusy}
                className="flex-1 bg-dark-700 hover:bg-dark-600 text-gray-300 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={saveProfile}
                disabled={profileBusy}
                className="flex-1 bg-cyan-500 hover:bg-cyan-400 text-dark-950 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-60"
              >
                {profileBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

function PlainField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-[11px] text-gray-500 block mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-dark-900 border border-dark-700 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500/50"
      />
    </div>
  );
}

function RolePill({ role }: { role: string }) {
  const map: Record<string, string> = {
    owner:   'bg-violet-500/15 text-violet-400 border-violet-500/30',
    admin:   'bg-blue-500/15 text-blue-400 border-blue-500/30',
    manager: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
    viewer:  'bg-gray-500/15 text-gray-400 border-gray-500/30',
  };
  return <span className={`px-2 py-0.5 text-[10px] rounded-md border capitalize ${map[role] ?? map.viewer}`}>{role}</span>;
}

// ── tiny helpers ────────────────────────────────────────────

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
    <div className="bg-dark-800 border border-dark-700 rounded-xl mt-5 overflow-hidden">
      <div className="px-5 py-3 border-b border-dark-700 flex items-center gap-2">
        <i className={`${icon} text-cyan-400`} />
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left font-medium tracking-wider">{children}</th>;
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-5 py-8 text-center text-gray-500 text-xs">{msg}</div>;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between items-start gap-3 border-b border-dark-700/50 last:border-0 pb-2 last:pb-0">
      <span className="text-gray-500">{k}</span>
      <span className="text-white text-right max-w-[60%] break-words">{v}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    trial:     'bg-blue-500/15 text-blue-400 border-blue-500/30',
    active:    'bg-green-500/15 text-green-400 border-green-500/30',
    expired:   'bg-red-500/15 text-red-400 border-red-500/30',
    suspended: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    revoked:   'bg-red-500/15 text-red-400 border-red-500/30',
    pending_payment: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    paid:      'bg-green-500/15 text-green-400 border-green-500/30',
    pending:   'bg-amber-500/15 text-amber-400 border-amber-500/30',
    online:    'bg-green-500/15 text-green-400 border-green-500/30',
    offline:   'bg-gray-500/15 text-gray-400 border-gray-500/30',
    idle:      'bg-amber-500/15 text-amber-400 border-amber-500/30',
  };
  return <span className={`px-2 py-0.5 text-[10px] rounded-md border capitalize ${map[status] ?? 'bg-dark-700 text-gray-400 border-dark-600'}`}>{status}</span>;
}
