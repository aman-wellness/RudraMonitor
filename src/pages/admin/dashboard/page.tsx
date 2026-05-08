import { useEffect, useState } from 'react';
import AdminLayout from '../AdminLayout';
import { supabase } from '@/lib/supabase';

type Counts = { partners: number; partnersPending: number; orgs: number; licensesActive: number; invoicesPending: number; revenueInr: number };

export default function AdminDashboard() {
  const [c, setC] = useState<Counts>({ partners: 0, partnersPending: 0, orgs: 0, licensesActive: 0, invoicesPending: 0, revenueInr: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [p, pp, o, la, ip, rev] = await Promise.all([
        supabase.from('partners').select('id', { count: 'exact', head: true }),
        supabase.from('partners').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('organizations').select('id', { count: 'exact', head: true }),
        supabase.from('licenses').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('invoices').select('total_inr').eq('status', 'paid'),
      ]);
      const revenueInr = (rev.data ?? []).reduce((s: number, r: { total_inr: number }) => s + Number(r.total_inr || 0), 0);
      setC({
        partners: p.count ?? 0,
        partnersPending: pp.count ?? 0,
        orgs: o.count ?? 0,
        licensesActive: la.count ?? 0,
        invoicesPending: ip.count ?? 0,
        revenueInr,
      });
      setLoading(false);
    })();
  }, []);

  const cards = [
    { label: 'Total Partners',     value: c.partners,        sub: `${c.partnersPending} pending approval`, icon: 'ri-team-line',         color: 'text-purple-400' },
    { label: 'Customers',          value: c.orgs,            sub: 'all orgs',                              icon: 'ri-building-line',     color: 'text-blue-400' },
    { label: 'Active Licenses',    value: c.licensesActive,  sub: 'currently in use',                      icon: 'ri-key-2-line',        color: 'text-green-400' },
    { label: 'Pending Invoices',   value: c.invoicesPending, sub: 'awaiting payment',                      icon: 'ri-bill-line',         color: 'text-yellow-400' },
    { label: 'Revenue (paid)',     value: `₹${c.revenueInr.toLocaleString('en-IN')}`, sub: 'all-time',     icon: 'ri-currency-line',     color: 'text-emerald-400' },
  ];

  return (
    <AdminLayout title="Dashboard">
      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {cards.map((card) => (
            <div key={card.label} className="bg-dark-800 border border-dark-700 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] uppercase tracking-wider text-gray-500">{card.label}</p>
                <i className={`${card.icon} ${card.color}`} />
              </div>
              <p className="text-2xl font-semibold text-white">{card.value}</p>
              <p className="text-[11px] text-gray-500 mt-1">{card.sub}</p>
            </div>
          ))}
        </div>
      )}
    </AdminLayout>
  );
}
