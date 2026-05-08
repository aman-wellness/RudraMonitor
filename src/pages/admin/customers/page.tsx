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

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Organization</th>
              <th className="px-4 py-3 text-left">Partner</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Agents</th>
              <th className="px-4 py-3 text-left">Licenses</th>
              <th className="px-4 py-3 text-left">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500 text-xs">No customers</td></tr>
            )}
            {filtered.map((o) => (
              <tr key={o.id} className="hover:bg-dark-700/30">
                <td className="px-4 py-3 text-white">
                  <Link to={`/admin/customers/${o.id}`} className="hover:text-cyan-400">{o.name}</Link>
                </td>
                <td className="px-4 py-3 text-gray-400">{o.partner?.name ?? <span className="text-gray-600">— direct —</span>}</td>
                <td className="px-4 py-3"><StatusPill status={o.subscription_status} /></td>
                <td className="px-4 py-3 text-gray-300">{o.agent_count}</td>
                <td className="px-4 py-3 text-gray-300">{o.active_license_count}</td>
                <td className="px-4 py-3 text-gray-500 text-[11px]">
                  {new Date(o.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </td>
              </tr>
            ))}
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

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    trial:   'bg-blue-500/15 text-blue-400 border-blue-500/30',
    active:  'bg-green-500/15 text-green-400 border-green-500/30',
    expired: 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  return <span className={`px-2 py-0.5 text-[10px] rounded-md border capitalize ${map[status] ?? 'bg-dark-700 text-gray-400 border-dark-600'}`}>{status}</span>;
}
