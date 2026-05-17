import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../AdminLayout';
import { supabase, type Organization } from '@/lib/supabase';
import NewCustomerModal from '@/components/billing/NewCustomerModal';

type Row = Organization & {
  partner: { name: string } | null;
  agent_count: number;
  active_license_count: number;
};

export default function AdminCustomers() {
  const [rows, setRows] = useState<Row[]>([]);
  const [partners, setPartners] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'direct' | 'partner'>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    let q = supabase
      .from('organizations')
      .select('*, partner:partners(name)')
      .order('created_at', { ascending: false });
    if (filter === 'direct') q = q.is('partner_id', null);
    if (filter === 'partner') q = q.not('partner_id', 'is', null);
    const { data: orgs } = await q;

    // Counts in two follow-up queries (rather than nested counts)
    const orgIds = (orgs ?? []).map((o) => o.id);
    let agentCounts: Record<string, number> = {};
    let licenseCounts: Record<string, number> = {};
    if (orgIds.length > 0) {
      const { data: agents } = await supabase.from('agents').select('org_id').in('org_id', orgIds);
      const { data: licenses } = await supabase
        .from('licenses').select('organization_id,status').in('organization_id', orgIds);
      agentCounts = (agents ?? []).reduce((acc, a: { org_id: string }) => {
        acc[a.org_id] = (acc[a.org_id] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      licenseCounts = (licenses ?? []).filter((l: { status: string }) => l.status === 'active')
        .reduce((acc, l: { organization_id: string }) => {
          acc[l.organization_id] = (acc[l.organization_id] ?? 0) + 1;
          return acc;
        }, {} as Record<string, number>);
    }

    setRows(((orgs as Row[]) ?? []).map((o) => ({
      ...o,
      agent_count: agentCounts[o.id] ?? 0,
      active_license_count: licenseCounts[o.id] ?? 0,
    })));
    setLoading(false);
  };

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('partners').select('id,name').eq('status', 'active').order('name');
      setPartners(data ?? []);
    })();
  }, []);

  useEffect(() => { load(); }, [filter]);

  const filtered = rows.filter((r) =>
    !search || r.name.toLowerCase().includes(search.toLowerCase())
  );

  // Suspend / re-activate flips both the org status and all of its active licenses
  // (otherwise the agents would keep ingesting). The agent's enrollment check
  // looks at organizations.subscription_status, so suspend is real-time.
  const setStatus = async (o: Row, status: 'active' | 'suspended') => {
    if (!confirm(`${status === 'suspended' ? 'Suspend' : 'Re-activate'} "${o.name}"?`)) return;
    setBusy(o.id); setError(null);
    const { error: e1 } = await supabase
      .from('organizations')
      .update({ subscription_status: status })
      .eq('id', o.id);
    if (!e1) {
      // Pause all licenses too — when re-activating, anything that was 'suspended'
      // by us comes back to 'active'; expired licenses stay expired.
      const newLicenseStatus = status === 'suspended' ? 'suspended' : 'active';
      const fromStatus = status === 'suspended' ? 'active' : 'suspended';
      await supabase
        .from('licenses')
        .update({ status: newLicenseStatus })
        .eq('organization_id', o.id)
        .eq('status', fromStatus);
    }
    if (e1) setError(`Status change failed: ${e1.message}`);
    else await load();
    setBusy(null);
  };

  const deleteCustomer = async (o: Row) => {
    if (!confirm(`Delete customer "${o.name}"? All licenses, agents, and historical data for this organization will be removed. This cannot be undone.`)) return;
    if (!confirm(`Type-check: this will permanently delete ALL of ${o.name}'s data. Continue?`)) return;
    setBusy(o.id); setError(null);
    const { error: e1 } = await supabase.from('organizations').delete().eq('id', o.id);
    if (e1) setError(`Delete failed: ${e1.message}`);
    else await load();
    setBusy(null);
  };

  const resendOwnerInvite = async (o: Row) => {
    setBusy(o.id); setError(null);
    try {
      // Find the pending owner row (lowest-rank admin without a user_id, or any admin).
      const { data: members } = await supabase
        .from('org_members').select('email, full_name, role')
        .eq('org_id', o.id).order('role').limit(1);
      const m = members?.[0];
      if (!m?.email) throw new Error('No owner email on file for this org.');

      const { data: sess } = await supabase.auth.getSession();
      const jwt = sess.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-invite-customer-owner`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ org_id: o.id, email: m.email, full_name: m.full_name, role: m.role ?? 'admin' }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `invite ${res.status}`);
      }
    } catch (e) {
      setError(`Resend failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminLayout title="Customers">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          {(['all', 'direct', 'partner'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs rounded-lg capitalize ${filter === f ? 'bg-dark-700 text-white' : 'bg-dark-800 text-gray-500 hover:text-gray-300'}`}>
              {f === 'all' ? 'All' : f === 'direct' ? 'Direct' : 'Via Partner'}
            </button>
          ))}
          <input
            value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
            className="ml-2 bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none w-48"
          />
        </div>
        <button onClick={() => setOpen(true)}
          className="px-3 py-1.5 text-xs rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium">
          + New Customer
        </button>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Organization</th>
              <th className="px-4 py-3 text-left">Partner</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Add-ons</th>
              <th className="px-4 py-3 text-left">Agents</th>
              <th className="px-4 py-3 text-left">Licenses</th>
              <th className="px-4 py-3 text-left">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500 text-xs">No customers</td></tr>
            )}
            {filtered.map((o) => {
              const isSuspended = o.subscription_status === 'suspended';
              return (
              <tr key={o.id} className="hover:bg-dark-700/30">
                <td className="px-4 py-3 text-white">
                  <Link to={`/admin/customers/${o.id}`} className="hover:text-cyan-400">{o.name}</Link>
                </td>
                <td className="px-4 py-3 text-gray-400">{o.partner?.name ?? <span className="text-gray-600">— direct —</span>}</td>
                <td className="px-4 py-3"><StatusPill status={o.subscription_status} /></td>
                <td className="px-4 py-3"><AddonChips org={o} /></td>
                <td className="px-4 py-3 text-gray-300">{o.agent_count}</td>
                <td className="px-4 py-3 text-gray-300">{o.active_license_count}</td>
                <td className="px-4 py-3 text-gray-500 text-[11px]">
                  {new Date(o.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1.5 flex-wrap">
                    <Link
                      to={`/admin/customers/${o.id}`}
                      className="px-2.5 py-1 text-[11px] rounded-md bg-dark-700 hover:bg-dark-600 text-gray-300"
                    >
                      View
                    </Link>
                    <button
                      disabled={busy === o.id}
                      onClick={() => resendOwnerInvite(o)}
                      className="px-2.5 py-1 text-[11px] rounded-md bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 disabled:opacity-40"
                    >
                      {busy === o.id ? '…' : 'Resend Invite'}
                    </button>
                    {isSuspended ? (
                      <button
                        disabled={busy === o.id}
                        onClick={() => setStatus(o, 'active')}
                        className="px-2.5 py-1 text-[11px] rounded-md bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
                      >
                        Re-activate
                      </button>
                    ) : (
                      <button
                        disabled={busy === o.id}
                        onClick={() => setStatus(o, 'suspended')}
                        className="px-2.5 py-1 text-[11px] rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 disabled:opacity-40"
                      >
                        Suspend
                      </button>
                    )}
                    <button
                      disabled={busy === o.id}
                      onClick={() => deleteCustomer(o)}
                      className="px-2.5 py-1 text-[11px] rounded-md bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <NewCustomerModal
        open={open}
        onClose={() => setOpen(false)}
        onCreated={load}
        showPartnerPicker
        partners={partners}
      />
    </AdminLayout>
  );
}

function AddonChips({ org }: { org: Row }) {
  const o = org as unknown as {
    em_subscribed?: boolean;
    trial_ends_at?: string | null;
    subscription_status: string;
    features?: Record<string, boolean> | null;
  };
  const trialActive = o.subscription_status === 'trial' && o.trial_ends_at && new Date(o.trial_ends_at) > new Date();
  const emOn = !!o.em_subscribed || !!trialActive;
  const dlpOverride = o.features?.dlp;
  const dlpOn = dlpOverride === true || (dlpOverride === undefined && !!trialActive);
  const chips: Array<{ label: string; on: boolean }> = [
    { label: 'EM', on: emOn },
    { label: 'DLP', on: dlpOn },
  ];
  return (
    <div className="flex gap-1 flex-wrap">
      {chips.map((c) => (
        <span key={c.label}
          className={`px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider border ${
            c.on
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              : 'bg-dark-700 text-gray-500 border-dark-600'
          }`}
          title={c.on ? `${c.label} active` : `${c.label} inactive`}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    trial:     'bg-blue-500/15 text-blue-400 border-blue-500/30',
    active:    'bg-green-500/15 text-green-400 border-green-500/30',
    expired:   'bg-red-500/15 text-red-400 border-red-500/30',
    suspended: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  };
  return <span className={`px-2 py-0.5 text-[10px] rounded-md border capitalize ${map[status] ?? 'bg-dark-700 text-gray-400 border-dark-600'}`}>{status}</span>;
}
