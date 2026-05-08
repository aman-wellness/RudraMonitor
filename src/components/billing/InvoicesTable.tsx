import { useEffect, useState } from 'react';
import { supabase, type InvoiceStatus } from '@/lib/supabase';
import { payInvoice } from '@/lib/razorpay';

type Row = {
  id: string;
  invoice_number: string;
  organization_id: string;
  partner_id: string | null;
  license_id: string | null;
  amount_inr: number;
  gst_amount_inr: number;
  total_inr: number;
  partner_commission_inr: number;
  status: InvoiceStatus;
  issued_at: string;
  due_at: string | null;
  paid_at: string | null;
  organizations: { name: string } | null;
  partners: { name: string } | null;
  licenses: { license_key: string } | null;
};

const statusColor: Record<InvoiceStatus, string> = {
  pending:   'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  paid:      'bg-green-500/15 text-green-400 border-green-500/30',
  failed:    'bg-red-500/15 text-red-400 border-red-500/30',
  refunded:  'bg-blue-500/15 text-blue-400 border-blue-500/30',
  cancelled: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

interface Props {
  scope: 'super_admin' | 'partner';
  partnerId?: string | null;
  /** When true, shows commission column (partner view). */
  showCommission?: boolean;
}

export default function InvoicesTable({ scope, partnerId, showCommission }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | InvoiceStatus>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    let q = supabase
      .from('invoices')
      .select('id,invoice_number,organization_id,partner_id,license_id,amount_inr,gst_amount_inr,total_inr,partner_commission_inr,status,issued_at,due_at,paid_at,organizations(name),partners(name),licenses(license_key)')
      .order('issued_at', { ascending: false });
    if (scope === 'partner' && partnerId) q = q.eq('partner_id', partnerId);
    if (filter !== 'all') q = q.eq('status', filter);
    const { data, error } = await q;
    if (error) setError(error.message);
    setRows((data as unknown as Row[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [filter, partnerId, scope]);

  const pay = async (inv: Row) => {
    setBusy(inv.id); setError(null);
    try {
      await payInvoice({
        invoiceId: inv.id,
        customerName: inv.organizations?.name,
        onSuccess: () => {
          // Webhook updates DB; poll for ~10s to reflect status
          let tries = 0;
          const t = setInterval(async () => {
            tries++;
            await load();
            if (tries >= 5) clearInterval(t);
          }, 2000);
        },
        onDismiss: () => setBusy(null),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'payment failed');
    } finally {
      setBusy(null);
    }
  };

  const filters: Array<'all' | InvoiceStatus> = ['all', 'pending', 'paid', 'failed', 'cancelled'];

  return (
    <>
      <div className="flex items-center gap-2 mb-4">
        {filters.map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 text-xs rounded-lg capitalize ${filter === f ? 'bg-dark-700 text-white' : 'bg-dark-800 text-gray-500 hover:text-gray-300'}`}>
            {f}
          </button>
        ))}
      </div>
      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Invoice</th>
              <th className="px-4 py-3 text-left">Customer</th>
              {scope === 'super_admin' && <th className="px-4 py-3 text-left">Partner</th>}
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-right">GST</th>
              <th className="px-4 py-3 text-right">Total</th>
              {showCommission && <th className="px-4 py-3 text-right">Commission</th>}
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Due</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={10} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-6 text-center text-gray-500 text-xs">No invoices</td></tr>
            )}
            {rows.map((i) => (
              <tr key={i.id} className="hover:bg-dark-700/30">
                <td className="px-4 py-3 text-white font-mono text-xs">{i.invoice_number}</td>
                <td className="px-4 py-3 text-gray-300">{i.organizations?.name ?? '—'}</td>
                {scope === 'super_admin' && <td className="px-4 py-3 text-gray-400">{i.partners?.name ?? <span className="text-gray-600">— direct —</span>}</td>}
                <td className="px-4 py-3 text-right text-gray-300">₹{Number(i.amount_inr).toLocaleString('en-IN')}</td>
                <td className="px-4 py-3 text-right text-gray-500">₹{Number(i.gst_amount_inr).toLocaleString('en-IN')}</td>
                <td className="px-4 py-3 text-right text-white font-medium">₹{Number(i.total_inr).toLocaleString('en-IN')}</td>
                {showCommission && <td className="px-4 py-3 text-right text-emerald-400">₹{Number(i.partner_commission_inr).toLocaleString('en-IN')}</td>}
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 text-[10px] rounded-md border capitalize ${statusColor[i.status]}`}>{i.status}</span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-[11px]">
                  {i.due_at ? new Date(i.due_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  {i.status === 'pending' && (
                    <button onClick={() => pay(i)} disabled={busy === i.id}
                      className="px-3 py-1 text-[11px] rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/30 disabled:opacity-50">
                      {busy === i.id ? 'Opening…' : 'Pay'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
