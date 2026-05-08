import { useEffect, useState } from 'react';
import PartnerLayout from '../PartnerLayout';
import { supabase, type Organization } from '@/lib/supabase';
import { useAppRole } from '@/lib/useAppRole';
import NewCustomerModal from '@/components/billing/NewCustomerModal';

type Row = Organization & { active_license_count: number; agent_count: number };

export default function PartnerCustomers() {
  const { partnerId } = useAppRole();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    if (!partnerId) return;
    setLoading(true);
    const { data: orgs } = await supabase
      .from('organizations').select('*')
      .eq('partner_id', partnerId)
      .order('created_at', { ascending: false });

    const orgIds = (orgs ?? []).map((o) => o.id);
    let agentCounts: Record<string, number> = {};
    let licenseCounts: Record<string, number> = {};
    if (orgIds.length > 0) {
      const { data: agents } = await supabase.from('agents').select('org_id').in('org_id', orgIds);
      const { data: lic } = await supabase
        .from('licenses').select('organization_id,status')
        .eq('partner_id', partnerId).in('organization_id', orgIds);
      agentCounts = (agents ?? []).reduce((acc, a: { org_id: string }) => {
        acc[a.org_id] = (acc[a.org_id] ?? 0) + 1; return acc;
      }, {} as Record<string, number>);
      licenseCounts = (lic ?? []).filter((l: { status: string }) => l.status === 'active')
        .reduce((acc, l: { organization_id: string }) => {
          acc[l.organization_id] = (acc[l.organization_id] ?? 0) + 1; return acc;
        }, {} as Record<string, number>);
    }
    setRows(((orgs as Row[]) ?? []).map((o) => ({
      ...o,
      agent_count: agentCounts[o.id] ?? 0,
      active_license_count: licenseCounts[o.id] ?? 0,
    })));
    setLoading(false);
  };

  useEffect(() => { load(); }, [partnerId]);

  const filtered = rows.filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <PartnerLayout title="My Customers">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <input
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
          className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none w-48"
        />
        <button onClick={() => setOpen(true)}
          className="px-3 py-1.5 text-xs rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium">
          + Register New Customer
        </button>
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Organization</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Agents</th>
              <th className="px-4 py-3 text-left">Active Licenses</th>
              <th className="px-4 py-3 text-left">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500 text-xs">
                Koi customer nahi. Apna pehla customer register karo.
              </td></tr>
            )}
            {filtered.map((o) => (
              <tr key={o.id} className="hover:bg-dark-700/30">
                <td className="px-4 py-3 text-white">{o.name}</td>
                <td className="px-4 py-3">
                  <span className="px-2 py-0.5 text-[10px] rounded-md border bg-green-500/15 text-green-400 border-green-500/30 capitalize">
                    {o.subscription_status}
                  </span>
                </td>
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

      <NewCustomerModal open={open} onClose={() => setOpen(false)} onCreated={load} />
    </PartnerLayout>
  );
}
