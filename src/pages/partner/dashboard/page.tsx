import { useEffect, useState } from 'react';
import PartnerLayout from '../PartnerLayout';
import { supabase } from '@/lib/supabase';
import { useAppRole } from '@/lib/useAppRole';

export default function PartnerDashboard() {
  const { partnerId } = useAppRole();
  const [partnerName, setPartnerName] = useState<string>('');
  const [counts, setCounts] = useState({ orgs: 0, licensesActive: 0, commissionEarned: 0, commissionPending: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!partnerId) return;
    (async () => {
      const [partner, orgs, lic, paidInv, pendInv] = await Promise.all([
        supabase.from('partners').select('name,commission_pct').eq('id', partnerId).maybeSingle(),
        supabase.from('organizations').select('id', { count: 'exact', head: true }).eq('partner_id', partnerId),
        supabase.from('licenses').select('id', { count: 'exact', head: true }).eq('partner_id', partnerId).eq('status', 'active'),
        supabase.from('invoices').select('partner_commission_inr').eq('partner_id', partnerId).eq('status', 'paid'),
        supabase.from('invoices').select('partner_commission_inr').eq('partner_id', partnerId).eq('status', 'pending'),
      ]);
      const sum = (rows: { partner_commission_inr: number }[] | null) =>
        (rows ?? []).reduce((s, r) => s + Number(r.partner_commission_inr || 0), 0);
      setPartnerName((partner.data?.name as string) ?? '');
      setCounts({
        orgs: orgs.count ?? 0,
        licensesActive: lic.count ?? 0,
        commissionEarned: sum(paidInv.data),
        commissionPending: sum(pendInv.data),
      });
      setLoading(false);
    })();
  }, [partnerId]);

  const cards = [
    { label: 'My Customers',        value: counts.orgs,                                      icon: 'ri-building-line',  color: 'text-blue-400' },
    { label: 'Active Licenses',     value: counts.licensesActive,                            icon: 'ri-key-2-line',     color: 'text-green-400' },
    { label: 'Commission (paid)',   value: `₹${counts.commissionEarned.toLocaleString('en-IN')}`,    icon: 'ri-coin-line',      color: 'text-emerald-400' },
    { label: 'Commission (pending)',value: `₹${counts.commissionPending.toLocaleString('en-IN')}`,   icon: 'ri-time-line',      color: 'text-yellow-400' },
  ];

  return (
    <PartnerLayout title={partnerName ? `Welcome, ${partnerName}` : 'Dashboard'}>
      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {cards.map((c) => (
            <div key={c.label} className="bg-dark-800 border border-dark-700 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] uppercase tracking-wider text-gray-500">{c.label}</p>
                <i className={`${c.icon} ${c.color}`} />
              </div>
              <p className="text-2xl font-semibold text-white">{c.value}</p>
            </div>
          ))}
        </div>
      )}
    </PartnerLayout>
  );
}
