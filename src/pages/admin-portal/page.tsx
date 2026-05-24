import { useEffect, useMemo, useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAuth } from '@/context/AuthContext';
import { useAgents, useOrgMembers } from '@/lib/dataHooks';
import { useOrgRole } from '@/lib/useOrgRole';
import { supabase } from '@/lib/supabase';
import DepartmentsTab from './components/DepartmentsTab';
import PlanGrid from '@/components/PlanGrid';

interface OrgUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLogin: string;
}

const adminTabs = [
  { id: 'org', label: 'Organization', icon: 'ri-building-line' },
  { id: 'subscription', label: 'Subscription', icon: 'ri-vip-crown-line' },
  { id: 'users', label: 'Users', icon: 'ri-team-line' },
  { id: 'departments', label: 'Departments', icon: 'ri-organization-chart' },
  { id: 'settings', label: 'Settings', icon: 'ri-settings-3-line' },
];

const roles = ['Viewer', 'Manager', 'Org Admin'];

export default function AdminPortalPage() {
  const { organization, user, refreshOrganization } = useAuth();
  const { agents } = useAgents();
  const { members, inviteMember, removeMember, refresh } = useOrgMembers();
  const { canWrite, isViewer } = useOrgRole();
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);

  // If the org is partner-routed, fetch the partner's billing details so we show
  // them (not Rudrans) as the "billed by" entity in the customer's portal.
  const [billingEntity, setBillingEntity] = useState<null | {
    name: string; gst_number: string | null; pan_number: string | null;
    address: string | null; city: string | null; state: string | null;
    postal_code: string | null; country: string | null;
    contact_email: string | null; phone: string | null;
    is_partner: boolean;
  }>(null);
  const [orgInvoices, setOrgInvoices] = useState<Array<{
    id: string; invoice_number: string; total_inr: number; status: string;
    invoice_date: string; bill_from: string;
  }>>([]);

  // Real plans (from DB) + the customer's currently-active plan id (from their license).
  const [plans, setPlans] = useState<Array<{
    id: string; code: string; name: string; description: string | null;
    seat_count: number; price_inr: number; price_usd: number | null;
    billing_cycle: 'monthly' | 'yearly';
    features_included: string[];
  }>>([]);
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(null);

  useEffect(() => {
    if (!organization) return;
    (async () => {
      // The 3 active plans visible to customers — same source admin/partner use.
      const { data } = await supabase
        .from('plans')
        .select('id, code, name, description, seat_count, price_inr, price_usd, billing_cycle, features_included')
        .eq('is_active', true)
        .order('price_inr', { ascending: true });
      setPlans((data as never) ?? []);

      // Customer's active license → current plan.
      const { data: lic } = await supabase
        .from('licenses')
        .select('plan_id')
        .eq('organization_id', organization.id)
        .eq('status', 'active')
        .order('issued_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      setCurrentPlanId((lic as { plan_id?: string } | null)?.plan_id ?? null);
    })();
  }, [organization]);
  useEffect(() => {
    if (!organization) return;
    (async () => {
      if (organization.partner_id) {
        const { data } = await supabase
          .from('partners')
          .select('name, gst_number, pan_number, address, city, state, postal_code, country, contact_email, phone')
          .eq('id', organization.partner_id)
          .maybeSingle();
        if (data) {
          setBillingEntity({ ...(data as never), is_partner: true });
        }
      } else {
        // Direct customer — billed by Rudrans. These are the SaaS vendor's own details
        // (could be moved to an `app_settings` table later for editability).
        setBillingEntity({
          is_partner: false,
          name: 'Rudrans Technologies Pvt Ltd',
          gst_number: null, pan_number: null,
          address: 'Floor 4, Tower B, iThum Business Park',
          city: 'Noida', state: 'Uttar Pradesh', postal_code: '201309', country: 'IN',
          contact_email: 'billing@rudrans.com', phone: null,
        });
      }
      // Real invoices, partner-routed orgs only see the bill_from='partner' invoices
      // (the wholesale TF→partner leg is hidden — that's between Rudrans and the partner).
      const { data: invs } = await supabase
        .from('invoices')
        .select('id, invoice_number, total_inr, status, invoice_date, bill_from')
        .eq('organization_id', organization.id)
        .eq('bill_from', organization.partner_id ? 'partner' : 'trackforce')
        .order('invoice_date', { ascending: false })
        .limit(10);
      setOrgInvoices((invs as never) ?? []);
    })();
  }, [organization]);

  const [editingProfile, setEditingProfile] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileForm, setProfileForm] = useState({
    name: '', gst_number: '', address: '', city: '', state: '', phone: '',
  });
  useEffect(() => {
    if (organization) {
      setProfileForm({
        name: organization.name ?? '',
        gst_number: organization.gst_number ?? '',
        address: organization.address ?? '',
        city: organization.city ?? '',
        state: organization.state ?? '',
        phone: organization.phone ?? '',
      });
    }
  }, [organization]);

  const saveProfile = async () => {
    if (!organization) return;
    setProfileBusy(true); setProfileError(null);
    const { error } = await supabase
      .from('organizations')
      .update({
        name: profileForm.name.trim() || organization.name,
        gst_number: profileForm.gst_number.trim() || null,
        address: profileForm.address.trim() || null,
        city: profileForm.city.trim() || null,
        state: profileForm.state.trim() || null,
        phone: profileForm.phone.trim() || null,
      })
      .eq('id', organization.id);
    setProfileBusy(false);
    if (error) { setProfileError(error.message); return; }
    await refreshOrganization();
    setEditingProfile(false);
  };

  const initialTab = (() => {
    if (typeof window === 'undefined') return 'org';
    const t = new URLSearchParams(window.location.search).get('tab') ?? 'org';
    return adminTabs.some((x) => x.id === t) ? t : 'org';
  })();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [showAddUser, setShowAddUser] = useState(false);
  const [showEditUser, setShowEditUser] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [editingUser, setEditingUser] = useState<OrgUser | null>(null);

  // Map org_members → display rows. Email comes from session for self, the email column for
  // pending invites, and "—" for active non-self members (auth.users not exposed via anon).
  // DB role → UI label (must round-trip cleanly through the edit modal so
  // saving doesn't silently demote anyone).
  //   owner  → "Owner"      (read-only; can't be changed from the UI)
  //   admin  → "Org Admin"  (full org-level access)
  //   viewer → "Viewer"
  const fromMembers: OrgUser[] = useMemo(
    () =>
      members.map((m) => ({
        id: m.id,
        name: m.full_name ?? (m.email ?? '—'),
        email: m.user_id === user?.id ? user?.email ?? '—' : (m.email ?? '—'),
        role:
          m.role === 'owner' ? 'Owner' :
          m.role === 'admin' ? 'Org Admin' : 'Viewer',
        status: m.status,
        lastLogin: '—',
      })),
    [members, user],
  );
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([]);
  useEffect(() => { setOrgUsers(fromMembers); }, [fromMembers]);
  void removeMember; // exposed for future "Remove" action; not yet surfaced in UI.

  const [addName, setAddName] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState('Viewer');

  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState('Viewer');
  const [editStatus, setEditStatus] = useState('active');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);

  const [emailNotifications, setEmailNotifications] = useState(true);
  const [aiAlerts, setAiAlerts] = useState(true);
  const [autoScreenshot, setAutoScreenshot] = useState(true);
  const [autoVideo, setAutoVideo] = useState(true);
  const [dataRetention, setDataRetention] = useState('30');
  const [idleThreshold, setIdleThreshold] = useState('15');

  const openEditModal = (user: OrgUser) => {
    setEditingUser(user);
    setEditName(user.name);
    setEditEmail(user.email);
    setEditRole(user.role);
    setEditStatus(user.status);
    setShowEditUser(true);
    setShowResetPassword(false);
    setResetSuccess(false);
    setResetError('');
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleSaveUser = async () => {
    if (!editingUser) return;
    // UI role → DB role. We never let the UI demote / promote an owner — the
    // org creator role is permanent.
    if (editingUser.role === 'Owner') {
      setShowEditUser(false); setEditingUser(null);
      return;
    }
    const dbRole: 'admin' | 'viewer' = editRole === 'Viewer' ? 'viewer' : 'admin';
    const newName = editName.trim() || editingUser.name;

    const { error } = await supabase
      .from('org_members')
      .update({ role: dbRole, full_name: newName })
      .eq('id', editingUser.id);
    if (error) {
      alert(`Failed to save: ${error.message}`);
      return;
    }
    await refresh();
    setShowEditUser(false);
    setEditingUser(null);
  };

  const handleAddUser = async () => {
    if (!addEmail.trim()) {
      setInviteError('Email is required');
      return;
    }
    setInviteError(null);
    setInviteBusy(true);
    try {
      // UI roles → DB roles. org_members only supports admin/viewer; full
      // platform super_admin must be granted via /admin/users (separate role).
      // "Org Admin" + legacy "Super Admin" + "Manager" all → admin.
      const dbRole: 'admin' | 'viewer' =
        addRole === 'Viewer' ? 'viewer' : 'admin';
      await inviteMember({
        email: addEmail.trim(),
        role: dbRole,
        full_name: addName.trim() || undefined,
      });
      setAddName('');
      setAddEmail('');
      setAddRole('Viewer');
      setShowAddUser(false);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Invite failed');
    } finally {
      setInviteBusy(false);
    }
  };

  const handleResetPassword = () => {
    setResetError('');
    if (newPassword.length < 6) {
      setResetError('Password must be at least 6 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setResetError('Passwords do not match');
      return;
    }
    setResetSuccess(true);
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <DashboardLayout>
      <div className="space-y-5">
        {isViewer && (
          <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center gap-2">
            <i className="ri-eye-line" />
            <span><strong>Viewer mode</strong> — you have read-only access. To make changes, ask your Org Admin to upgrade your role.</span>
          </div>
        )}
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-dashboard-line" /></span>
            Dashboard
          </span>
          <i className="ri-arrow-right-s-line text-gray-600" />
          <span className="text-white font-medium">Admin Portal</span>
        </div>

        {/* Header */}
        <div>
          <h1 className="text-xl font-poppins font-bold text-white mb-1">Admin Portal</h1>
          <p className="text-sm text-gray-500">Manage your organization, subscription, users and system settings</p>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1 overflow-x-auto">
          {adminTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
                activeTab === tab.id ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <span className="w-4 h-4 flex items-center justify-center"><i className={`${tab.icon} text-sm`} /></span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* === ORGANIZATION TAB === */}
        {activeTab === 'org' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Company Profile */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 flex items-center justify-center"><i className="ri-building-line text-violet-400 text-sm" /></span>
                  <h3 className="text-sm font-semibold text-white">Company Profile</h3>
                </div>
                {!editingProfile ? (
                  <button
                    onClick={() => setEditingProfile(true)}
                    className="px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 text-[11px] font-medium border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors flex items-center gap-1"
                  >
                    <i className="ri-edit-line text-xs" /> Edit
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => { setEditingProfile(false); setProfileError(null); }}
                      disabled={profileBusy}
                      className="px-2.5 py-1 rounded-md bg-dark-700 text-gray-400 text-[11px] font-medium hover:bg-dark-600 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveProfile}
                      disabled={profileBusy}
                      className="px-2.5 py-1 rounded-md bg-emerald-500 text-dark-900 text-[11px] font-semibold hover:bg-emerald-400 transition-colors disabled:opacity-60"
                    >
                      {profileBusy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                )}
              </div>
              {profileError && <p className="text-[11px] text-red-400 mb-2">{profileError}</p>}

              {!editingProfile ? (
                <div className="space-y-3">
                  {[
                    { label: 'Company Name', value: organization?.name ?? '—', icon: 'ri-building-2-line' },
                    { label: 'GST Number', value: organization?.gst_number ?? '—', icon: 'ri-file-list-3-line' },
                    { label: 'Address', value: [organization?.address, organization?.city, organization?.state].filter(Boolean).join(', ') || '—', icon: 'ri-map-pin-line' },
                    { label: 'Contact Email', value: user?.email ?? '—', icon: 'ri-mail-line' },
                    { label: 'Phone', value: organization?.phone ?? '—', icon: 'ri-phone-line' },
                  ].map((field) => (
                    <div key={field.label} className="flex items-center gap-3">
                      <span className="w-5 h-5 flex items-center justify-center text-gray-600">
                        <i className={`${field.icon} text-xs`} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] text-gray-500">{field.label}</p>
                        <p className="text-xs text-white font-medium truncate">{field.value}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {([
                    { key: 'name', label: 'Company Name', placeholder: 'Acme Pvt Ltd' },
                    { key: 'gst_number', label: 'GST Number', placeholder: '22AAAAA0000A1Z5' },
                    { key: 'address', label: 'Address', placeholder: 'Street, building' },
                    { key: 'city', label: 'City', placeholder: 'Mumbai' },
                    { key: 'state', label: 'State', placeholder: 'Maharashtra' },
                    { key: 'phone', label: 'Phone', placeholder: '+91 98xxxxxx' },
                  ] as const).map((f) => (
                    <div key={f.key}>
                      <label className="text-[11px] text-gray-500 block mb-1">{f.label}</label>
                      <input
                        value={profileForm[f.key]}
                        onChange={(e) => setProfileForm((p) => ({ ...p, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        className="w-full bg-dark-900 border border-dark-700 rounded-md px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/50"
                      />
                    </div>
                  ))}
                  <div className="flex items-center gap-3 pt-1">
                    <span className="w-5 h-5 flex items-center justify-center text-gray-600"><i className="ri-mail-line text-xs" /></span>
                    <div className="flex-1">
                      <p className="text-[11px] text-gray-500">Contact Email (read-only)</p>
                      <p className="text-xs text-white font-medium">{user?.email ?? '—'}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* License Overview */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-5 h-5 flex items-center justify-center"><i className="ri-key-2-line text-emerald-400 text-sm" /></span>
                <h3 className="text-sm font-semibold text-white">License Overview</h3>
              </div>
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  {(() => {
                    const total = organization?.license_count ?? 0;
                    const used = agents.length;
                    const available = Math.max(0, total - used);
                    return [
                      { label: 'Total', value: String(total), color: 'text-white' },
                      { label: 'Used', value: String(used), color: 'text-emerald-400' },
                      { label: 'Available', value: String(available), color: 'text-gray-400' },
                    ];
                  })().map((stat) => (
                    <div key={stat.label} className="bg-dark-900 rounded-lg border border-dark-700 p-3 text-center">
                      <p className={`text-lg font-bold ${stat.color}`}>{stat.value}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{stat.label} Licenses</p>
                    </div>
                  ))}
                </div>
                <div className="bg-dark-900 rounded-lg border border-dark-700 p-3">
                  {(() => {
                    const total = organization?.license_count ?? 0;
                    const used = agents.length;
                    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
                    return (
                      <>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs text-gray-400">License Utilization</span>
                          <span className="text-xs text-emerald-400 font-medium">{pct}%</span>
                        </div>
                        <div className="w-full bg-dark-700 rounded-full h-2">
                          <div className="bg-emerald-500 h-2 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </>
                    );
                  })()}
                </div>
                <div className="bg-dark-900 rounded-lg border border-dark-700 p-3">
                  <p className="text-[11px] text-gray-500 mb-1">License Key</p>
                  <div className="flex items-center justify-between">
                    <code className="text-xs text-emerald-400 font-mono break-all">{organization?.license_key ?? '—'}</code>
                    <button
                      onClick={() => organization && navigator.clipboard.writeText(organization.license_key)}
                      className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded bg-dark-700 transition-colors flex-shrink-0 ml-2"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Subscription Plan */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-5 h-5 flex items-center justify-center"><i className="ri-vip-crown-line text-amber-400 text-sm" /></span>
                <h3 className="text-sm font-semibold text-white">Current Plan</h3>
              </div>
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-bold text-white capitalize">{organization?.subscription_status ?? 'trial'} Plan</h4>
                  {/* During the trial, the badge reflects the trial length (14 days)
                      rather than the underlying billing cycle — billing only kicks
                      in once a paid renewal is recorded. */}
                  <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-semibold capitalize">
                    {organization?.subscription_status === 'trial'
                      ? '14-Day Trial'
                      : organization?.subscription_type ?? 'monthly'}
                  </span>
                </div>
                <p className="text-xs text-gray-400">{organization?.license_count ?? 0} licenses</p>
              </div>
              <div className="space-y-2.5">
                {(() => {
                  const startDate = organization ? new Date(organization.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : '—';
                  const trialEnd = organization ? new Date(organization.trial_ends_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : '—';
                  const status = organization?.subscription_status ?? 'trial';
                  const isTrial = status === 'trial';
                  return [
                    { label: 'Started On', value: startDate },
                    { label: isTrial ? 'Trial Ends' : 'Renews On', value: trialEnd },
                    { label: 'Status', value: status.charAt(0).toUpperCase() + status.slice(1) },
                    {
                      label: 'Billing Cycle',
                      value: isTrial ? 'Free trial (no billing)' : (organization?.subscription_type ?? '—'),
                    },
                  ];
                })().map((item) => (
                  <div key={item.label} className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">{item.label}</span>
                    <span className="text-xs text-white font-medium">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Billed By — partner if partner-routed, Rudrans otherwise */}
            {billingEntity && (
              <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 flex items-center justify-center"><i className="ri-store-2-line text-cyan-400 text-sm" /></span>
                    <h3 className="text-sm font-semibold text-white">Billed By</h3>
                  </div>
                  <span className={`px-2 py-0.5 text-[10px] rounded-md border ${billingEntity.is_partner ? 'bg-violet-500/15 text-violet-400 border-violet-500/30' : 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'}`}>
                    {billingEntity.is_partner ? 'Channel Partner' : 'Direct (Rudrans)'}
                  </span>
                </div>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between"><span className="text-gray-500">Name</span><span className="text-white font-medium">{billingEntity.name}</span></div>
                  {billingEntity.gst_number && <div className="flex justify-between"><span className="text-gray-500">GST</span><span className="text-gray-300">{billingEntity.gst_number}</span></div>}
                  {billingEntity.pan_number && <div className="flex justify-between"><span className="text-gray-500">PAN</span><span className="text-gray-300">{billingEntity.pan_number}</span></div>}
                  {(billingEntity.address || billingEntity.city) && (
                    <div className="flex justify-between gap-3">
                      <span className="text-gray-500 flex-shrink-0">Address</span>
                      <span className="text-gray-300 text-right">
                        {[billingEntity.address, billingEntity.city, billingEntity.state, billingEntity.postal_code].filter(Boolean).join(', ')}
                      </span>
                    </div>
                  )}
                  {billingEntity.contact_email && <div className="flex justify-between"><span className="text-gray-500">Email</span><span className="text-gray-300">{billingEntity.contact_email}</span></div>}
                  {billingEntity.phone && <div className="flex justify-between"><span className="text-gray-500">Phone</span><span className="text-gray-300">{billingEntity.phone}</span></div>}
                </div>
                {billingEntity.is_partner && (
                  <p className="text-[11px] text-gray-500 mt-3 pt-3 border-t border-dark-700">
                    Your subscription is managed by this partner. All invoices and support requests are routed through them.
                  </p>
                )}
              </div>
            )}

            {/* Invoice History */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 flex items-center justify-center"><i className="ri-bill-line text-teal-400 text-sm" /></span>
                  <h3 className="text-sm font-semibold text-white">Invoice History</h3>
                </div>
              </div>
              {orgInvoices.length === 0 ? (
                <div className="bg-dark-900 rounded-lg border border-dark-700 p-6 text-center">
                  <span className="w-10 h-10 mx-auto mb-2 flex items-center justify-center text-gray-600">
                    <i className="ri-bill-line text-2xl" />
                  </span>
                  <p className="text-xs text-gray-400 font-medium">No invoices yet</p>
                  <p className="text-[11px] text-gray-600 mt-1">
                    Invoices appear here once your subscription is billed.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {orgInvoices.map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
                      <div>
                        <p className="text-xs text-white font-medium">{inv.invoice_number}</p>
                        <p className="text-[11px] text-gray-500">
                          {new Date(inv.invoice_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-white font-medium">₹ {Number(inv.total_inr).toLocaleString('en-IN')}</p>
                        <p className={`text-[10px] ${inv.status === 'paid' ? 'text-emerald-400' : inv.status === 'pending' ? 'text-amber-400' : 'text-gray-500'} capitalize`}>{inv.status}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* === SUBSCRIPTION TAB === */}
        {activeTab === 'subscription' && (
          <SubscriptionTab
            organization={organization}
            plans={plans}
            currentPlanId={currentPlanId}
          />
        )}
        {/* === USERS TAB === */}
        {activeTab === 'users' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            <div className="p-4 md:p-5 border-b border-dark-700 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Organization Users</h3>
                {isViewer && <p className="text-[11px] text-amber-300 mt-0.5">Read-only — you can view users but not edit. Ask an Org Admin for changes.</p>}
              </div>
              {canWrite && (
                <button
                  onClick={() => setShowAddUser(true)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors flex items-center gap-1.5"
                >
                  <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-add-line text-xs" /></span>
                  Add User
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">User</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Role</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Status</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Last Login</th>
                    <th className="text-right text-xs text-gray-500 font-medium px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orgUsers.map((user) => (
                    <tr key={user.id} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                            <span className="text-xs text-violet-400 font-semibold">{user.name.charAt(0)}</span>
                          </div>
                          <div>
                            <p className="text-sm text-white font-medium">{user.name}</p>
                            <p className="text-xs text-gray-500">{user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                          user.role === 'Super Admin' ? 'bg-red-500/15 text-red-400 border border-red-500/20' :
                          user.role === 'Manager' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20' :
                          'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                        }`}>
                          {user.role}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          user.status === 'active'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : user.status === 'pending'
                              ? 'bg-amber-500/15 text-amber-400'
                              : 'bg-gray-500/15 text-gray-400'
                        }`}>
                          {user.status === 'active' ? 'Active' : user.status === 'pending' ? 'Pending' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">{user.lastLogin}</td>
                      <td className="px-4 py-3 text-right">
                        {canWrite ? (
                          <button
                            onClick={() => openEditModal(user)}
                            className="px-3 py-1.5 rounded-lg bg-dark-700 text-gray-300 hover:text-white text-[11px] font-medium hover:bg-dark-600 transition-colors"
                          >
                            Edit
                          </button>
                        ) : (
                          <span className="text-[11px] text-gray-600">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add User Modal */}
            {showAddUser && (
              <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-md p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-white">Add New User</h3>
                    <button onClick={() => setShowAddUser(false)} className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-white">
                      <i className="ri-close-line text-sm" />
                    </button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="text-[11px] text-gray-500 block mb-1">Full Name</label>
                      <input
                        type="text"
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                        placeholder="Enter name"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-500 block mb-1">Email</label>
                      <input
                        type="email"
                        value={addEmail}
                        onChange={(e) => setAddEmail(e.target.value)}
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                        placeholder="user@company.com"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-500 block mb-1">Role</label>
                      <select
                        value={addRole}
                        onChange={(e) => setAddRole(e.target.value)}
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                      >
                        {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                  </div>
                  {inviteError && (
                    <div className="mt-3 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-[11px]">
                      {inviteError}
                    </div>
                  )}
                  <p className="text-[11px] text-gray-500 mt-3">
                    A magic-link invite is sent. The user joins your org once they confirm their email.
                  </p>
                  <div className="flex items-center gap-2 mt-3">
                    <button onClick={() => setShowAddUser(false)} className="flex-1 py-2 rounded-lg border border-dark-700 text-gray-400 text-xs font-medium hover:bg-dark-700 transition-colors">
                      Cancel
                    </button>
                    <button
                      onClick={handleAddUser}
                      disabled={inviteBusy}
                      className="flex-1 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/25 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
                    >
                      {inviteBusy ? 'Sending…' : 'Send Invite'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Edit User Modal */}
            {showEditUser && editingUser && (
              <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                <div className="bg-dark-800 border border-dark-700 rounded-xl w-full max-w-md p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-white">Edit User</h3>
                    <button
                      onClick={() => { setShowEditUser(false); setEditingUser(null); }}
                      className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-white"
                    >
                      <i className="ri-close-line text-sm" />
                    </button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="text-[11px] text-gray-500 block mb-1">Full Name</label>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                        placeholder="Enter name"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-500 block mb-1">Email</label>
                      <input
                        type="email"
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                        placeholder="user@company.com"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[11px] text-gray-500 block mb-1">Role</label>
                        <select
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value)}
                          className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                        >
                          {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] text-gray-500 block mb-1">Status</label>
                        <select
                          value={editStatus}
                          onChange={(e) => setEditStatus(e.target.value)}
                          className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                        >
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
                      </div>
                    </div>

                    {/* Password Reset Section */}
                    <div className="border-t border-dark-700 pt-3 mt-1">
                      {!showResetPassword && !resetSuccess && (
                        <button
                          onClick={() => setShowResetPassword(true)}
                          className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors"
                        >
                          <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-lock-unlock-line text-xs" /></span>
                          Reset Password
                        </button>
                      )}

                      {showResetPassword && !resetSuccess && (
                        <div className="space-y-3">
                          <p className="text-xs text-white font-medium">Reset Password</p>
                          <div>
                            <label className="text-[11px] text-gray-500 block mb-1">New Password</label>
                            <input
                              type="password"
                              value={newPassword}
                              onChange={(e) => { setNewPassword(e.target.value); setResetError(''); }}
                              className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                              placeholder="Min 6 characters"
                            />
                          </div>
                          <div>
                            <label className="text-[11px] text-gray-500 block mb-1">Confirm Password</label>
                            <input
                              type="password"
                              value={confirmPassword}
                              onChange={(e) => { setConfirmPassword(e.target.value); setResetError(''); }}
                              className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500/50"
                              placeholder="Re-enter password"
                            />
                          </div>
                          {resetError && (
                            <p className="text-[11px] text-red-400 flex items-center gap-1">
                              <span className="w-3 h-3 flex items-center justify-center"><i className="ri-error-warning-line text-xs" /></span>
                              {resetError}
                            </p>
                          )}
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => { setShowResetPassword(false); setResetError(''); setNewPassword(''); setConfirmPassword(''); }}
                              className="px-3 py-1.5 rounded-lg border border-dark-700 text-gray-400 text-[11px] font-medium hover:bg-dark-700 transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleResetPassword}
                              className="px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 text-[11px] font-medium border border-amber-500/25 hover:bg-amber-500/25 transition-colors"
                            >
                              Update Password
                            </button>
                          </div>
                        </div>
                      )}

                      {resetSuccess && (
                        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 flex items-center gap-2">
                          <span className="w-4 h-4 flex items-center justify-center text-emerald-400"><i className="ri-check-line text-xs" /></span>
                          <p className="text-xs text-emerald-400 font-medium">Password reset successfully!</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-5">
                    <button
                      onClick={() => { setShowEditUser(false); setEditingUser(null); }}
                      className="flex-1 py-2 rounded-lg border border-dark-700 text-gray-400 text-xs font-medium hover:bg-dark-700 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveUser}
                      className="flex-1 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors"
                    >
                      Save Changes
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* === DEPARTMENTS TAB === */}
        {activeTab === 'departments' && (
          <DepartmentsTab orgId={organization?.id ?? null} />
        )}

        {/* === SETTINGS TAB === */}
        {activeTab === 'settings' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Capture Controls */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-5 h-5 flex items-center justify-center"><i className="ri-camera-line text-emerald-400 text-sm" /></span>
                <h3 className="text-sm font-semibold text-white">Default Capture Controls</h3>
              </div>
              <p className="text-[11px] text-gray-500 mb-4">These settings apply to all newly registered agents. Override per agent on their detail page.</p>
              <div className="space-y-3">
                {[
                  { label: 'Auto Screenshot', desc: 'Capture screen on activity change', state: autoScreenshot, set: setAutoScreenshot },
                  { label: 'Auto Video Recording', desc: 'Record 10-min clips every interval', state: autoVideo, set: setAutoVideo },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
                    <div>
                      <p className="text-xs text-white font-medium">{item.label}</p>
                      <p className="text-[11px] text-gray-500">{item.desc}</p>
                    </div>
                    <button
                      onClick={() => item.set(!item.state)}
                      className={`w-10 h-5 rounded-full transition-colors relative ${item.state ? 'bg-emerald-500' : 'bg-dark-700'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${item.state ? 'left-[22px]' : 'left-[2px]'}`} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Alert Settings */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-5 h-5 flex items-center justify-center"><i className="ri-notification-3-line text-amber-400 text-sm" /></span>
                <h3 className="text-sm font-semibold text-white">Alert Settings</h3>
              </div>
              <div className="space-y-3">
                {[
                  { label: 'Email Notifications', desc: 'Send alert emails to admins', state: emailNotifications, set: setEmailNotifications },
                  { label: 'AI Auto-Resolution', desc: 'Let AI attempt to fix alerts', state: aiAlerts, set: setAiAlerts },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
                    <div>
                      <p className="text-xs text-white font-medium">{item.label}</p>
                      <p className="text-[11px] text-gray-500">{item.desc}</p>
                    </div>
                    <button
                      onClick={() => item.set(!item.state)}
                      className={`w-10 h-5 rounded-full transition-colors relative ${item.state ? 'bg-emerald-500' : 'bg-dark-700'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${item.state ? 'left-[22px]' : 'left-[2px]'}`} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Data Policy */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-5 h-5 flex items-center justify-center"><i className="ri-database-2-line text-sky-400 text-sm" /></span>
                <h3 className="text-sm font-semibold text-white">Data & Privacy</h3>
              </div>
              <div className="space-y-3">
                <div className="bg-dark-900 rounded-lg border border-dark-700 p-3">
                  <label className="text-xs text-white font-medium block mb-2">Data Retention (days)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min="7" max="365" value={dataRetention}
                      onChange={(e) => setDataRetention(e.target.value)}
                      className="flex-1 accent-emerald-500"
                    />
                    <span className="text-xs text-emerald-400 font-medium w-10 text-right">{dataRetention}</span>
                  </div>
                </div>
                <div className="bg-dark-900 rounded-lg border border-dark-700 p-3">
                  <label className="text-xs text-white font-medium block mb-2">Idle Threshold (minutes)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range" min="5" max="60" value={idleThreshold}
                      onChange={(e) => setIdleThreshold(e.target.value)}
                      className="flex-1 accent-emerald-500"
                    />
                    <span className="text-xs text-emerald-400 font-medium w-10 text-right">{idleThreshold}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Danger Zone */}
            <DangerZone orgId={organization?.id ?? null} />
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

type Plan = {
  id: string;
  code: string;
  name: string;
  seat_count: number;
  price_inr: number;
  billing_cycle: string;
  features_included: string[];
};

type OrgLite = {
  name?: string | null;
  subscription_status?: string | null;
  subscription_type?: string | null;
  trial_ends_at?: string | null;
  license_count?: number | null;
} | null;

function SubscriptionTab({
  organization, plans, currentPlanId,
}: {
  organization: OrgLite & { id?: string; em_subscribed?: boolean | null };
  plans: Plan[];
  currentPlanId: string | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pendingReq, setPendingReq] = useState<{ plan_id: string; plan_name: string; created_at: string } | null>(null);

  useEffect(() => {
    if (!organization?.id) return;
    (async () => {
      const { data } = await supabase
        .from('plan_upgrade_requests')
        .select('plan_id, status, created_at, plans(name)')
        .eq('org_id', organization.id!)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      type Row = { plan_id: string; created_at: string; plans: { name: string } | null };
      const row = data as Row | null;
      if (row) setPendingReq({ plan_id: row.plan_id, plan_name: row.plans?.name ?? '—', created_at: row.created_at });
      else setPendingReq(null);
    })();
  }, [organization?.id]);

  const isTrial = organization?.subscription_status === 'trial';
  const current = plans.find((p) => p.id === currentPlanId) ?? null;
  const currentPlanCode = current?.code ?? null;

  // Pick the closest v2 plan SKU for an upgrade request when the user
  // clicks a tier in PlanGrid. The grid hands us back a v2 code (e.g.
  // 'pro-y'); if that exact code doesn't exist yet in the customer's
  // `plans` table (rare — they all get seeded), fall back to a legacy
  // SKU with the same family.
  const findPlanRowByCode = (v2Code: string): Plan | null => {
    // Exact match first.
    const exact = plans.find((p) => p.code === v2Code);
    if (exact) return exact;
    // Fall back: match by tier family.
    if (v2Code.startsWith('starter-')) return plans.find((p) => /^starter/i.test(p.code)) ?? null;
    if (v2Code.startsWith('pro-'))     return plans.find((p) => /^(pro|growth)/i.test(p.code)) ?? null;
    if (v2Code.startsWith('em-'))      return plans.find((p) => /^em/i.test(p.code)) ?? null;
    if (v2Code === 'enterprise')       return plans.find((p) => /^scale|enterprise/i.test(p.code)) ?? null;
    return null;
  };

  const startUpgrade = async (p: Plan, extraNote?: string) => {
    if (!organization?.id) { setMsg({ kind: 'err', text: 'Missing org context' }); return; }
    const msg = `Request upgrade to "${p.name}"${extraNote ? ` (${extraNote})` : ''}? Our team will reach out within one business day to finalize billing.`;
    if (!confirm(msg)) return;
    setBusy(`plan-${p.id}`); setMsg(null);
    const { error, data } = await supabase
      .from('plan_upgrade_requests')
      .insert({ org_id: organization.id, plan_id: p.id })
      .select('plan_id, created_at')
      .single();
    setBusy(null);
    if (error) { setMsg({ kind: 'err', text: error.message }); return; }
    setPendingReq({ plan_id: p.id, plan_name: p.name, created_at: (data as { created_at: string }).created_at });
    setMsg({ kind: 'ok', text: `Upgrade requested — we'll reach out shortly to switch you to ${p.name}.` });
  };

  // Bridge between PlanGrid's onSelect (plan code + cycle + seats + addons)
  // and the existing email-Rudrans `plan_upgrade_requests` flow. Phase 7
  // (Razorpay) will replace this with direct Razorpay checkout.
  const handlePlanSelect = (sel: { planCode: string; seats: number; addons: string[] }) => {
    if (sel.planCode === 'enterprise') {
      window.open('mailto:hello@rudrans.com?subject=Enterprise%20plan%20enquiry', '_blank');
      return;
    }
    const row = findPlanRowByCode(sel.planCode);
    if (!row) {
      setMsg({ kind: 'err', text: `Plan ${sel.planCode} not found. Contact support.` });
      return;
    }
    const noteParts: string[] = [`${sel.seats} seats`];
    if (sel.addons.length > 0) noteParts.push(`add-ons: ${sel.addons.join(', ')}`);
    void startUpgrade(row, noteParts.join(' · '));
  };

  const cancelRequest = async () => {
    if (!organization?.id || !confirm('Cancel the pending upgrade request?')) return;
    setBusy('cancel');
    await supabase.from('plan_upgrade_requests')
      .update({ status: 'cancelled' })
      .eq('org_id', organization.id)
      .eq('status', 'pending');
    setBusy(null);
    setPendingReq(null);
    setMsg({ kind: 'ok', text: 'Upgrade request cancelled.' });
  };

  return (
    <div className="space-y-4">
      {msg && (
        <div className={`px-3 py-2 rounded-lg text-xs border ${
          msg.kind === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
        }`}>{msg.text}</div>
      )}

      {pendingReq && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <i className="ri-time-line text-amber-400 text-xl" />
            <div className="min-w-0">
              <p className="text-sm text-amber-200 font-medium">Upgrade pending: <span className="text-white">{pendingReq.plan_name}</span></p>
              <p className="text-[11px] text-amber-200/70">
                Requested {new Date(pendingReq.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} — our team will reach out to finalize billing.
              </p>
            </div>
          </div>
          <button
            onClick={cancelRequest}
            disabled={busy === 'cancel'}
            className="px-3 py-1.5 rounded-md text-[11px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 disabled:opacity-40"
          >
            Cancel request
          </button>
        </div>
      )}

      {/* ===== CURRENT SUBSCRIPTION (banner only) ===== */}
      <div className="bg-gradient-to-br from-emerald-500/10 to-cyan-500/10 border border-emerald-500/25 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-5 h-5 flex items-center justify-center"><i className="ri-vip-crown-line text-emerald-400" /></span>
          <p className="text-[11px] uppercase tracking-wider text-emerald-300 font-medium">Your Current Plan</p>
          {isTrial && (
            <span className="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 text-[10px] font-semibold border border-blue-500/30">
              14-Day Trial · all features unlocked
            </span>
          )}
        </div>
        <h2 className="text-2xl font-poppins font-bold text-white">{current?.name ?? (isTrial ? 'Free Trial' : '—')}</h2>
        {current && (
          <p className="text-sm text-gray-300 mt-1">
            {current.seat_count} agent{current.seat_count === 1 ? '' : 's'}
            {' · '}{current.billing_cycle}
          </p>
        )}
        {!current && organization?.license_count != null && (
          <p className="text-sm text-gray-300 mt-1">{organization.license_count} agents · {isTrial ? 'Trial period' : 'No active plan'}</p>
        )}
        {isTrial && organization?.trial_ends_at && (
          <p className="text-xs text-amber-300 mt-2">
            Trial ends {new Date(organization.trial_ends_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
            {' — choose a plan below to keep your data and features.'}
          </p>
        )}
      </div>

      {/* ===== AVAILABLE PLANS — shared PlanGrid (matches landing + /subscription) ===== */}
      <div className="pt-2">
        <PlanGrid
          currentPlanCode={currentPlanCode}
          disableCtas={!!pendingReq}
          ctaLabelFor={(planCode, isCurrent) => {
            if (isCurrent) return 'Active Plan';
            if (pendingReq) return 'Request pending';
            if (planCode === 'enterprise') return 'Contact Sales';
            return 'Select & Upgrade';
          }}
          onSelect={handlePlanSelect}
        />
        <p className="text-[11px] text-gray-500 mt-6 text-center max-w-3xl mx-auto">
          Razorpay billing for v2 plans is rolling out. For now, clicking <strong>Select &amp; Upgrade</strong>
          {' '}submits a request to our team — we&apos;ll switch your plan within one business day.
        </p>
      </div>
    </div>
  );
}
// Danger Zone — used to be a static UI block with non-functional Run buttons.
// Now each action POSTs to /functions/v1/org-purge with the user's JWT; the
// edge fn re-checks org_members.role and does the cleanup with the service
// role. Storage objects under <org_id>/ are also removed for screenshot/video
// purges so the freed seat doesn't carry stale media.
function DangerZone({ orgId }: { orgId: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  type Action = 'screenshots' | 'videos' | 'reset_agents';
  const actions: { key: Action; label: string; desc: string; icon: string; confirm: string }[] = [
    {
      key: 'screenshots',
      label: 'Purge All Screenshots',
      desc: 'Delete every stored screenshot for this organisation. Storage files + activity_logs rows. Cannot be undone.',
      icon: 'ri-image-line',
      confirm: 'Delete EVERY screenshot for this organisation? This cannot be undone.',
    },
    {
      key: 'videos',
      label: 'Purge All Videos',
      desc: 'Delete every stored video clip. Storage files + activity_logs rows. Cannot be undone.',
      icon: 'ri-video-line',
      confirm: 'Delete EVERY video clip for this organisation? This cannot be undone.',
    },
    {
      key: 'reset_agents',
      label: 'Reset All Agents',
      desc: 'Rotate enroll_token + mark offline. Agents must be re-installed / re-licensed to resume reporting.',
      icon: 'ri-refresh-line',
      confirm: 'Disconnect EVERY agent and force re-enrollment? Existing agents will start failing immediately.',
    },
  ];

  const run = async (action: Action, confirmText: string) => {
    if (!orgId) {
      setFeedback({ kind: 'err', text: 'Organisation not loaded yet.' });
      return;
    }
    if (!confirm(confirmText)) return;
    setBusy(action);
    setFeedback(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const jwt = sess.session?.access_token;
      if (!jwt) throw new Error('No active session');
      // supabase.functions.invoke would also work, but doing the fetch explicitly
      // here makes the failure modes (network, 4xx body) easier to surface to
      // the operator standing in front of the Danger Zone.
      const url = `${import.meta.env.VITE_SUPABASE_URL || 'https://api.rudrans.com'}/functions/v1/org-purge`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
        },
        body: JSON.stringify({ action, org_id: orgId }),
      });
      const data: Record<string, unknown> = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${resp.status}`);
      }
      const summary =
        action === 'reset_agents'
          ? `Reset ${data.agents_reset ?? 0} agent(s).`
          : `Deleted ${data.rows_deleted ?? 0} row(s) + ${data.files_deleted ?? 0} stored file(s).`;
      setFeedback({ kind: 'ok', text: summary });
    } catch (e) {
      setFeedback({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-dark-800 border border-red-500/20 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 flex items-center justify-center"><i className="ri-alert-line text-red-400 text-sm" /></span>
          <h3 className="text-sm font-semibold text-white">Danger Zone</h3>
        </div>
        {feedback && (
          <span className={`text-[11px] ${feedback.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
            {feedback.text}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {actions.map((a) => (
          <div key={a.key} className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 flex items-center justify-center text-gray-600"><i className={`${a.icon} text-xs`} /></span>
              <div>
                <p className="text-xs text-white font-medium">{a.label}</p>
                <p className="text-[11px] text-gray-500">{a.desc}</p>
              </div>
            </div>
            <button
              onClick={() => void run(a.key, a.confirm)}
              disabled={busy !== null || !orgId}
              className="px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 text-[11px] font-medium hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === a.key ? 'Running…' : 'Run'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
