import { useCallback, useEffect, useState } from 'react';
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
  total_inr: number;
  status: string;
  issued_at: string;
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
    const newSeats = Math.max(0, Math.floor(profileForm.license_count || 0));
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
        license_count: newSeats,
      })
      .eq('id', org.id);
    if (error) {
      setProfileBusy(false);
      alert(`Update failed: ${error.message}`);
      return;
    }

    // Mirror the seat change onto the active license so the agent-side checks
    // (which read licenses.seat_count) stay consistent with the org-level count.
    const activeLicense = licenses.find((l) => l.status === 'active');
    if (activeLicense && activeLicense.seat_count !== newSeats) {
      const { error: licErr } = await supabase
        .from('licenses')
        .update({ seat_count: newSeats })
        .eq('id', activeLicense.id);
      if (licErr) {
        setProfileBusy(false);
        alert(`Seat update failed on license: ${licErr.message}`);
        return;
      }
      setLicenses((ls) => ls.map((l) => (l.id === activeLicense.id ? { ...l, seat_count: newSeats } : l)));
    }

    setProfileBusy(false);
    setOrg({ ...org, ...profileForm });
    setEditing(false);
  };

  const sendPasswordReset = async (email: string) => {
    setResetState({ email, status: 'sending' });
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
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
          .select('id, invoice_number, total_inr, status, issued_at')
          .eq('organization_id', customerId)
          .order('issued_at', { ascending: false })
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
                    <div className="flex items-center justify-end gap-1.5 flex-wrap">
                      {l.status === 'pending_payment' && (
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
                      )}
                      <button
                        onClick={async () => {
                          const periodsStr = prompt(
                            'Extend renewal by how many billing periods? (1 = +1 month for monthly, +1 year for yearly plans)\n\nLeave blank to set a custom expiry date instead.',
                            '1',
                          );
                          if (periodsStr === null) return;
                          let untilArg: string | null = null;
                          let periodsArg = 1;
                          if (periodsStr.trim() === '') {
                            const customDate = prompt('Enter the new expiry date (YYYY-MM-DD):');
                            if (!customDate) return;
                            const d = new Date(customDate);
                            if (Number.isNaN(d.getTime())) { alert('Invalid date'); return; }
                            untilArg = d.toISOString();
                          } else {
                            const n = parseInt(periodsStr, 10);
                            if (!Number.isFinite(n) || n < 1) { alert('Invalid number of periods'); return; }
                            periodsArg = n;
                          }
                          if (!confirm(`Confirm: payment received, extending license renewal${untilArg ? ` until ${new Date(untilArg).toDateString()}` : ` by ${periodsArg} period(s)`}?`)) return;
                          const { error: extErr } = await supabase.rpc('extend_license_renewal', {
                            p_license_id: l.id,
                            p_periods: periodsArg,
                            p_until:   untilArg,
                          });
                          if (extErr) alert(`Extend failed: ${extErr.message}`);
                          else if (customerId) {
                            const { data: licRes } = await supabase.from('licenses')
                              .select('id, license_key, status, seat_count, issued_at, expires_at, plan:plans(name)')
                              .eq('organization_id', customerId)
                              .order('issued_at', { ascending: false });
                            setLicenses((licRes as unknown as LicenseRow[]) ?? []);
                            await load();
                          }
                        }}
                        className="px-2.5 py-1 rounded-md text-[10px] font-medium bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25"
                      >
                        Extend Renewal
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* Pending upgrade requests from the customer */}
      <Section title="Upgrade Requests" icon="ri-arrow-up-circle-line">
        <UpgradeRequests orgId={org.id} onApproved={async () => {
          // Reload licenses after approval so admin sees the new plan_id.
          const { data: licRes } = await supabase.from('licenses')
            .select('id, license_key, status, seat_count, issued_at, expires_at, plan:plans(name)')
            .eq('organization_id', org.id)
            .order('issued_at', { ascending: false });
          setLicenses((licRes as unknown as LicenseRow[]) ?? []);
        }} />
      </Section>

      {/* Subscription & Add-ons (super_admin) */}
      <Section title="Subscription & Add-ons" icon="ri-vip-crown-line">
        <SubscriptionControls
          org={org}
          onChange={(patch) => setOrg({ ...org, ...patch })}
        />
      </Section>

      {/* Monitoring feature overrides (super_admin) */}
      <Section title="Monitoring Features" icon="ri-toggle-line">
        <FeatureToggles
          orgId={org.id}
          isTrial={org.subscription_status === 'trial'}
        />
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
                <tr key={i.id} className="hover:bg-dark-700/30 cursor-pointer" onClick={() => navigate(`/invoices/${i.id}`)}>
                  <td className="px-4 py-2 font-mono text-cyan-400">{i.invoice_number}</td>
                  <td className="px-4 py-2 text-gray-500">{new Date(i.issued_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-4 py-2 text-white">₹ {Number(i.total_inr).toLocaleString('en-IN')}</td>
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

function UpgradeRequests({ orgId, onApproved }: { orgId: string; onApproved: () => Promise<void> | void }) {
  type Req = {
    id: string;
    plan_id: string;
    status: string;
    created_at: string;
    note: string | null;
    plans: { name: string; price_inr: number; seat_count: number } | null;
  };
  const [rows, setRows] = useState<Req[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from('plan_upgrade_requests')
      .select('id, plan_id, status, created_at, note, plans(name, price_inr, seat_count)')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(10);
    setRows((data as unknown as Req[]) ?? []);
  };
  useEffect(() => { load(); }, [orgId]);

  const decide = async (r: Req, decision: 'approved' | 'rejected') => {
    if (!confirm(`${decision === 'approved' ? 'Approve' : 'Reject'} upgrade to "${r.plans?.name ?? r.plan_id}"?`)) return;
    setBusy(r.id);

    if (decision === 'approved') {
      // We need the target plan's `code` AND current org state to know
      // whether we're switching a trial or a paid subscription.
      const seats = r.plans?.seat_count ?? 0;
      const [{ data: planRow }, { data: orgRow }, { data: lic }] = await Promise.all([
        supabase.from('plans').select('code').eq('id', r.plan_id).maybeSingle(),
        supabase.from('organizations')
          .select('subscription_status, trial_plan_code, em_subscribed')
          .eq('id', orgId).maybeSingle(),
        supabase.from('licenses').select('id, status')
          .eq('organization_id', orgId).eq('status', 'active')
          .order('issued_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      const newCode = (planRow as { code?: string } | null)?.code ?? null;

      if (lic?.id) {
        const { error: licErr } = await supabase
          .from('licenses')
          .update({ plan_id: r.plan_id, seat_count: seats })
          .eq('id', lic.id);
        if (licErr) { alert(`Failed to switch license: ${licErr.message}`); setBusy(null); return; }
      }

      // Build the org patch:
      //   • license_count mirrors seats so the agent-side checks stay in sync.
      //   • If the customer is still on a trial, point trial_plan_code at
      //     the new plan so org_effective_features() unlocks the right set
      //     for the remainder of the trial.
      //   • EM-family plans flip em_subscribed=true so the EM card on the
      //     admin detail page and org_em_active() show ACTIVE without
      //     waiting on the legacy "via trial" inference.
      const orgPatch: Record<string, unknown> = { license_count: seats };
      if (orgRow?.subscription_status === 'trial' && newCode) {
        orgPatch.trial_plan_code = newCode;
      }
      if (newCode === 'em-m' || newCode === 'em-y' || newCode === 'em-addon-m' || newCode === 'em-addon-y') {
        orgPatch.em_subscribed = true;
        if (!orgRow?.em_subscribed) orgPatch.em_subscribed_since = new Date().toISOString();
      }
      const { error: orgErr } = await supabase.from('organizations').update(orgPatch).eq('id', orgId);
      if (orgErr) { alert(`Failed to update org: ${orgErr.message}`); setBusy(null); return; }
    }

    const { error } = await supabase
      .from('plan_upgrade_requests')
      .update({ status: decision, decided_at: new Date().toISOString() })
      .eq('id', r.id);
    setBusy(null);
    if (error) { alert(error.message); return; }
    await load();
    if (decision === 'approved') await onApproved();
  };

  const pending = rows.filter((r) => r.status === 'pending');
  const history = rows.filter((r) => r.status !== 'pending');

  if (rows.length === 0) {
    return <div className="px-5 py-4 text-xs text-gray-500">No upgrade requests yet.</div>;
  }

  return (
    <div className="px-5 py-4 space-y-3">
      {pending.length > 0 && pending.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <i className="ri-time-line text-amber-400" />
              <p className="text-sm text-white font-medium">{r.plans?.name ?? '—'}</p>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">Pending</span>
            </div>
            <p className="text-[11px] text-gray-400">
              ₹{r.plans?.price_inr?.toLocaleString('en-IN') ?? '—'} · {r.plans?.seat_count ?? '—'} agents · requested {new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              disabled={busy === r.id}
              onClick={() => decide(r, 'approved')}
              className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-40"
            >
              Approve & switch
            </button>
            <button
              disabled={busy === r.id}
              onClick={() => decide(r, 'rejected')}
              className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-rose-500/15 text-rose-300 border border-rose-500/30 hover:bg-rose-500/25 disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        </div>
      ))}
      {history.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">History</p>
          <table className="w-full text-xs">
            <tbody className="divide-y divide-dark-700/60">
              {history.map((r) => (
                <tr key={r.id}>
                  <td className="px-2 py-1.5 text-gray-300">{r.plans?.name ?? '—'}</td>
                  <td className="px-2 py-1.5"><StatusPill status={r.status} /></td>
                  <td className="px-2 py-1.5 text-gray-500 text-right">{new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SubscriptionControls({
  org,
  onChange,
}: {
  org: CustomerView;
  onChange: (patch: Partial<CustomerView>) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const patch = async (key: string, updates: Record<string, unknown>) => {
    setBusy(key); setErr(null);
    const { error } = await supabase.from('organizations').update(updates).eq('id', org.id);
    setBusy(null);
    if (error) { setErr(error.message); return false; }
    onChange(updates as Partial<CustomerView>);
    return true;
  };

  const setStatus = async (status: 'trial' | 'active' | 'suspended' | 'canceled') => {
    if (!confirm(`Change subscription status to "${status}"?`)) return;
    await patch('status', { subscription_status: status });
  };

  const extendTrial = async (days: number) => {
    const base = org.trial_ends_at && new Date(org.trial_ends_at) > new Date()
      ? new Date(org.trial_ends_at)
      : new Date();
    base.setDate(base.getDate() + days);
    if (!confirm(`Extend trial to ${base.toLocaleDateString('en-IN')}?`)) return;
    await patch('trial', {
      trial_ends_at: base.toISOString(),
      subscription_status: 'trial',
    });
  };

  const trialDate = (org as unknown as { trial_ends_at: string | null }).trial_ends_at;
  const emSubscribed = !!(org as unknown as { em_subscribed: boolean }).em_subscribed;
  // EM is "via trial" only when the trial actually grants EM — i.e. the
  // customer signed up for the EM-scoped trial or a super admin granted
  // full-features access. A Starter (or DLP, or Professional-only) trial
  // does NOT include EM, so we must NOT mark the EM card as active.
  const trialPlanCode  = (org as unknown as { trial_plan_code: string | null }).trial_plan_code ?? null;
  const trialFullAccess = !!(org as unknown as { trial_full_access: boolean }).trial_full_access;
  const trialActive = org.subscription_status === 'trial' && !!trialDate && new Date(trialDate) > new Date();

  // Resolve a friendly plan label so the status row shows WHICH plan is
  // active (not just "Trial"). Trials read trial_plan_code; paid orgs
  // read from the most-recent active license.
  const [planLabel, setPlanLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (trialActive && trialPlanCode) {
        const { data } = await supabase.from('plans').select('name').eq('code', trialPlanCode).maybeSingle();
        if (!cancelled) setPlanLabel((data?.name as string | null) ?? null);
        return;
      }
      const { data: lic } = await supabase
        .from('licenses').select('plans(name, code)').eq('organization_id', org.id)
        .eq('status', 'active').order('issued_at', { ascending: false }).limit(1).maybeSingle();
      const row = (lic as { plans?: { name?: string } | { name?: string }[] | null } | null)?.plans;
      const name = Array.isArray(row) ? row[0]?.name : row?.name;
      if (!cancelled) setPlanLabel(name ?? null);
    })();
    return () => { cancelled = true; };
  }, [org.id, trialPlanCode, org.subscription_status, trialFullAccess, trialActive]);
  const trialGrantsEm = trialActive && (
    trialFullAccess
    || trialPlanCode === null              // legacy pre-0075 org — keep old behaviour
    || trialPlanCode === 'em-m'
    || trialPlanCode === 'em-y'
  );
  const emActiveByTrial = trialGrantsEm;

  const toggleEm = async (enable: boolean) => {
    const action = enable ? 'enable' : 'disable';
    if (!confirm(`${action.toUpperCase()} Employee Management add-on for ${org.name}?`)) return;
    await patch('em', {
      em_subscribed: enable,
      em_subscribed_since: enable ? new Date().toISOString() : null,
    });
  };

  return (
    <div className="px-5 py-4 space-y-5">
      {err && (
        <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
          {err}
        </div>
      )}

      {/* Status row */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wider">Subscription status</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <StatusPill status={org.subscription_status} />
              {planLabel && (
                <span className="px-2 py-0.5 text-[10px] rounded-md border bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
                  {planLabel}
                  {trialActive && trialFullAccess && <span className="ml-1 text-emerald-300">· full features</span>}
                </span>
              )}
              {trialDate && org.subscription_status === 'trial' && (
                <span className="text-[11px] text-gray-500">
                  Trial ends {new Date(trialDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {org.subscription_status !== 'active' && (
              <button onClick={() => setStatus('active')} disabled={busy === 'status'}
                className="px-2.5 py-1 text-[10px] rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-40">
                Activate
              </button>
            )}
            {org.subscription_status !== 'trial' && (
              <button onClick={() => setStatus('trial')} disabled={busy === 'status'}
                className="px-2.5 py-1 text-[10px] rounded-md bg-blue-500/15 text-blue-300 border border-blue-500/30 hover:bg-blue-500/25 disabled:opacity-40">
                Put on trial
              </button>
            )}
            {org.subscription_status !== 'suspended' && (
              <button onClick={() => setStatus('suspended')} disabled={busy === 'status'}
                className="px-2.5 py-1 text-[10px] rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 disabled:opacity-40">
                Suspend
              </button>
            )}
            {org.subscription_status !== 'canceled' && (
              <button onClick={() => setStatus('canceled')} disabled={busy === 'status'}
                className="px-2.5 py-1 text-[10px] rounded-md bg-rose-500/15 text-rose-300 border border-rose-500/30 hover:bg-rose-500/25 disabled:opacity-40">
                Cancel
              </button>
            )}
          </div>
        </div>

        {(org.subscription_status === 'trial' || !trialDate) && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-gray-500">Extend trial:</span>
            {[7, 14, 30].map((d) => (
              <button key={d} onClick={() => extendTrial(d)} disabled={busy === 'trial'}
                className="px-2 py-1 text-[10px] rounded-md bg-dark-700 text-gray-300 border border-dark-600 hover:text-white hover:border-cyan-500/40 disabled:opacity-40">
                +{d}d
              </button>
            ))}
            <button onClick={async () => {
              const v = prompt('Set trial expiry (YYYY-MM-DD):');
              if (!v) return;
              const d = new Date(v);
              if (Number.isNaN(d.getTime())) { alert('Invalid date'); return; }
              await patch('trial', { trial_ends_at: d.toISOString(), subscription_status: 'trial' });
            }} disabled={busy === 'trial'}
              className="px-2 py-1 text-[10px] rounded-md bg-dark-700 text-gray-300 border border-dark-600 hover:text-white hover:border-cyan-500/40 disabled:opacity-40">
              Custom…
            </button>
          </div>
        )}
      </div>

      {/* Add-ons */}
      <div>
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Add-on subscriptions</p>
        <div className="space-y-2">
          <AddonRow
            label="Employee Management"
            hint="Provisioning, M365/Google sync, groups, credentials vault, hardware, offboarding."
            enabled={emSubscribed}
            inheritedFromTrial={!emSubscribed && !!emActiveByTrial}
            busy={busy === 'em'}
            onEnable={() => toggleEm(true)}
            onDisable={() => toggleEm(false)}
            price="₹8,500 / mo"
          />
        </div>
        <p className="text-[10px] text-gray-600 mt-2">
          Trial customers get all add-ons automatically until trial expires. Toggling here bypasses Razorpay — useful for comped accounts.
        </p>
      </div>

      <ManualAddonGrant orgId={org.id} />
    </div>
  );
}

// Super-admin manual addon grant / revoke. Bypasses Razorpay entirely —
// inserts org_addons row via grant_addon_admin RPC + writes audit log.
// Useful when a webhook silently failed or for comped customers.
function ManualAddonGrant({ orgId }: { orgId: string }) {
  const [addonCode, setAddonCode] = useState<'dlp-addon-m' | 'dlp-addon-y' | 'em-addon-m' | 'em-addon-y'>('dlp-addon-m');
  const [seats, setSeats] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'grant' | 'revoke' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [active, setActive] = useState<Array<{ id: string; code: string; name: string; seat_count: number }>>([]);

  const loadActive = useCallback(async () => {
    const { data } = await supabase
      .from('org_addons')
      .select('id, seat_count, plans!inner(code, name)')
      .eq('org_id', orgId).eq('active', true);
    type J = { id: string; seat_count: number; plans: { code: string; name: string } | { code: string; name: string }[] };
    setActive(((data as J[]) ?? []).map((r) => {
      const p = Array.isArray(r.plans) ? r.plans[0] : r.plans;
      return { id: r.id, code: p.code, name: p.name, seat_count: r.seat_count };
    }));
  }, [orgId]);

  useEffect(() => { void loadActive(); }, [loadActive]);

  const grant = async () => {
    setBusy('grant'); setMsg(null);
    const { error } = await supabase.rpc('grant_addon_admin', {
      p_org_id: orgId, p_addon_plan_code: addonCode,
      p_seats: Math.max(1, seats), p_reason: reason.trim() || null,
    });
    setBusy(null);
    if (error) setMsg({ kind: 'err', text: error.message });
    else { setMsg({ kind: 'ok', text: `Granted ${addonCode} × ${seats}` }); await loadActive(); }
  };
  const revoke = async (code: string) => {
    if (!confirm(`Revoke ${code}? This drops all agent assignments too.`)) return;
    setBusy('revoke'); setMsg(null);
    const { error } = await supabase.rpc('revoke_addon_admin', {
      p_org_id: orgId, p_addon_plan_code: code, p_reason: reason.trim() || null,
    });
    setBusy(null);
    if (error) setMsg({ kind: 'err', text: error.message });
    else { setMsg({ kind: 'ok', text: `Revoked ${code}` }); await loadActive(); }
  };

  return (
    <div className="mt-5 border-t border-dark-700 pt-4">
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Manual addon grant / revoke (bypasses Razorpay)</p>

      {active.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {active.map((a) => (
            <div key={a.id} className="flex items-center justify-between bg-dark-900/50 border border-dark-700 rounded-lg px-3 py-2 text-xs">
              <span className="text-white">
                <span className="font-medium">{a.name}</span>
                <span className="text-gray-500 ml-2">{a.code} · {a.seat_count} seats</span>
              </span>
              <button onClick={() => revoke(a.code)} disabled={!!busy}
                      className="px-2 py-1 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 disabled:opacity-50">
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end bg-dark-900/50 rounded-lg p-3 border border-dark-700">
        <div className="md:col-span-2">
          <label className="block text-[10px] text-gray-500 uppercase mb-1">Add-on</label>
          <select value={addonCode} onChange={(e) => setAddonCode(e.target.value as typeof addonCode)}
                  className="w-full bg-dark-800 border border-dark-700 rounded px-2 py-1.5 text-xs text-white">
            <option value="dlp-addon-m">DLP Add-on (monthly)</option>
            <option value="dlp-addon-y">DLP Add-on (yearly)</option>
            <option value="em-addon-m">Employee Management Add-on (monthly)</option>
            <option value="em-addon-y">Employee Management Add-on (yearly)</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 uppercase mb-1">Seats</label>
          <input type="number" min={1} max={10000} value={seats}
                 onChange={(e) => setSeats(Math.max(1, parseInt(e.target.value || '1', 10)))}
                 className="w-full bg-dark-800 border border-dark-700 rounded px-2 py-1.5 text-xs text-white" />
        </div>
        <div>
          <button onClick={grant} disabled={!!busy}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-dark-950 font-medium text-xs px-3 py-1.5 rounded">
            {busy === 'grant' ? 'Granting…' : 'Grant'}
          </button>
        </div>
        <div className="md:col-span-4">
          <label className="block text-[10px] text-gray-500 uppercase mb-1">Reason (audit log)</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)}
                 placeholder="e.g. webhook failure, comped, support refund"
                 className="w-full bg-dark-800 border border-dark-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600" />
        </div>
      </div>

      {msg && (
        <p className={`mt-2 text-[11px] px-3 py-1.5 rounded border ${
          msg.kind === 'ok' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                            : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
        }`}>{msg.text}</p>
      )}
    </div>
  );
}

function AddonRow({
  label, hint, enabled, inheritedFromTrial, busy, onEnable, onDisable, price,
}: {
  label: string; hint: string; enabled: boolean; inheritedFromTrial: boolean;
  busy: boolean; onEnable: () => void; onDisable: () => void; price: string;
}) {
  const effective = enabled || inheritedFromTrial;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-dark-900/50 border border-dark-700">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm text-white">{label}</p>
          <span className={`px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider border ${effective ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-rose-500/10 text-rose-300 border-rose-500/30'}`}>
            {effective ? 'Active' : 'Inactive'}
          </span>
          {inheritedFromTrial && (
            <span className="px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider border bg-blue-500/15 text-blue-300 border-blue-500/30">
              Via trial
            </span>
          )}
          <span className="text-[10px] text-gray-500">{price}</span>
        </div>
        <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button disabled={busy} onClick={onEnable}
          className={`px-2 py-1 text-[10px] rounded ${enabled ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-500/40' : 'bg-dark-800 text-gray-400 border border-dark-700 hover:text-white'}`}>
          Enable
        </button>
        <button disabled={busy} onClick={onDisable}
          className={`px-2 py-1 text-[10px] rounded ${!enabled ? 'bg-rose-500/25 text-rose-200 border border-rose-500/40' : 'bg-dark-800 text-gray-400 border border-dark-700 hover:text-white'}`}>
          Disable
        </button>
      </div>
    </div>
  );
}

const FEATURE_LIST: Array<{ key: string; label: string; hint: string }> = [
  { key: 'screenshots',         label: 'Screenshots',         hint: 'Periodic desktop captures' },
  { key: 'video_recording',     label: 'Video Recording',     hint: 'Screen-recording sessions' },
  { key: 'dlp',                 label: 'DLP (USB / Email)',   hint: 'Block unauthorized file movement' },
  { key: 'ai_alerts',           label: 'Smart AI Alerts',     hint: 'AI-classified anomaly alerts' },
  { key: 'productivity_reports',label: 'Productivity Reports',hint: 'Daily / weekly productivity rollups' },
];

function FeatureToggles({ orgId, isTrial }: { orgId: string; isTrial: boolean }) {
  const [features, setFeatures] = useState<Record<string, boolean | null>>({});
  const [planFeats, setPlanFeats] = useState<string[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: org } = await supabase
        .from('organizations')
        .select('features, trial_plan_code, trial_full_access, subscription_status')
        .eq('id', orgId)
        .maybeSingle();
      // null = no override (= use plan default). true/false = explicit override.
      const map: Record<string, boolean | null> = {};
      for (const f of FEATURE_LIST) {
        const v = (org?.features as Record<string, boolean> | null)?.[f.key];
        map[f.key] = v === undefined ? null : v;
      }
      setFeatures(map);

      // Resolve which features the org's CURRENT subscription bundles:
      //   • trial w/ full access → every feature (super-admin granted)
      //   • trial with a trial_plan_code → that plan's features
      //   • otherwise → the active license's plan
      // Falling back to the license keeps paid orgs (and pre-0075 trials
      // without a trial_plan_code) working unchanged.
      const onTrial = org?.subscription_status === 'trial';
      const fullAccess = !!org?.trial_full_access;
      if (onTrial && fullAccess) {
        setPlanFeats(['monitoring_basic','screenshots','videos','live','remote','dlp','employee_management','video_recording','ai_alerts','productivity_reports']);
        return;
      }
      if (onTrial && org?.trial_plan_code) {
        const { data: tp } = await supabase
          .from('plans').select('features_included').eq('code', org.trial_plan_code).maybeSingle();
        setPlanFeats((tp?.features_included as string[] | null) ?? []);
        return;
      }
      const { data: lic } = await supabase
        .from('licenses').select('plans(features_included)')
        .eq('organization_id', orgId).eq('status','active')
        .order('issued_at', { ascending: false }).limit(1).maybeSingle();
      type LicFlat = { plans: { features_included: string[] } | null };
      const plan = (lic as unknown as LicFlat | null)?.plans;
      setPlanFeats(plan?.features_included ?? []);
    })();
  }, [orgId]);

  const save = async (key: string, value: boolean | null) => {
    setSaving(key);
    const { data: cur } = await supabase
      .from('organizations').select('features').eq('id', orgId).maybeSingle();
    const next = { ...((cur?.features as Record<string, boolean>) ?? {}) };
    if (value === null) delete next[key];
    else next[key] = value;
    const { error } = await supabase
      .from('organizations').update({ features: next }).eq('id', orgId);
    if (!error) setFeatures((f) => ({ ...f, [key]: value }));
    setSaving(null);
  };

  return (
    <div className="px-5 py-4">
      <p className="text-[11px] text-gray-500 mb-4 max-w-2xl">
        Each feature has 3 states: <strong className="text-emerald-300">On</strong> (force enabled),
        {' '}<strong className="text-rose-300">Off</strong> (force disabled), or
        {' '}<strong className="text-gray-300">Plan default</strong> (use what the plan bundles).
        {isTrial && <span className="block mt-1 text-blue-300">⓵ This customer is on trial — only their plan's features are unlocked (super-admin grant or "Approve & switch" upgrades the trial). "Plan default" below uses the active plan; "On" force-enables regardless.</span>}
      </p>
      <div className="space-y-2">
        {FEATURE_LIST.map((f) => {
          const v = features[f.key];
          // Legacy plan rows used `productivity_reports`, `video_recording`,
          // `ai_alerts`, `screenshots` codes; v2 plans expand those into
          // `monitoring_basic` / `screenshots` / `videos`. Mirror the
          // mapping public.org_effective_features() applies so the toggle
          // reflects what the customer's gate actually sees.
          const inPlan = (k: string) => planFeats.includes(k);
          const planIncludes = inPlan(f.key) || (
            f.key === 'productivity_reports' ? inPlan('monitoring_basic') :
            f.key === 'screenshots'          ? inPlan('monitoring_basic') || inPlan('screenshots') :
            f.key === 'video_recording'      ? inPlan('videos') :
            f.key === 'ai_alerts'            ? inPlan('monitoring_basic') :
            false
          );
          const effective = v === null ? planIncludes : v;
          return (
            <div key={f.key} className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-dark-900/50 border border-dark-700">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-white">{f.label}</p>
                  <span className={`px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider border ${effective ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-rose-500/10 text-rose-300 border-rose-500/30'}`}>
                    {effective ? 'Active' : 'Inactive'}
                  </span>
                  {v === null && (
                    <span className="px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider border bg-dark-700 text-gray-400 border-dark-600">
                      Plan default {planIncludes ? '(on)' : '(off)'}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">{f.hint}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  disabled={saving === f.key}
                  onClick={() => save(f.key, true)}
                  className={`px-2 py-1 text-[10px] rounded ${v === true ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-500/40' : 'bg-dark-800 text-gray-400 border border-dark-700 hover:text-white'}`}
                >On</button>
                <button
                  disabled={saving === f.key}
                  onClick={() => save(f.key, false)}
                  className={`px-2 py-1 text-[10px] rounded ${v === false ? 'bg-rose-500/25 text-rose-200 border border-rose-500/40' : 'bg-dark-800 text-gray-400 border border-dark-700 hover:text-white'}`}
                >Off</button>
                <button
                  disabled={saving === f.key}
                  onClick={() => save(f.key, null)}
                  className={`px-2 py-1 text-[10px] rounded ${v === null ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-500/40' : 'bg-dark-800 text-gray-400 border border-dark-700 hover:text-white'}`}
                  title="Use whatever the plan bundles"
                >Plan</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
