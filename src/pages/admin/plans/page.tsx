import { useEffect, useState } from 'react';
import AdminLayout from '../AdminLayout';
import { supabase, type Plan } from '@/lib/supabase';

export default function AdminPlans() {
  const [rows, setRows] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Plan> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from('plans').select('*').order('seat_count');
    setRows((data as Plan[]) ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing) return;
    setError(null);
    const payload = {
      code: editing.code, name: editing.name, description: editing.description ?? null,
      seat_count: Number(editing.seat_count),
      price_inr: Number(editing.price_inr),
      price_usd: editing.price_usd != null ? Number(editing.price_usd) : null,
      partner_price_inr: Number(editing.partner_price_inr ?? Math.round((editing.price_inr ?? 0) * 0.7 * 100) / 100),
      billing_cycle: editing.billing_cycle ?? 'yearly', is_active: editing.is_active ?? true,
    };
    const { error } = editing.id
      ? await supabase.from('plans').update(payload).eq('id', editing.id)
      : await supabase.from('plans').insert(payload);
    if (error) setError(error.message);
    else { setEditing(null); await load(); }
  };

  const toggleActive = async (p: Plan) => {
    await supabase.from('plans').update({ is_active: !p.is_active }).eq('id', p.id);
    await load();
  };

  return (
    <AdminLayout title="Plans">
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500 max-w-2xl">
          Each plan stores three prices: <span className="text-emerald-400">List INR</span> (used for invoices &amp; GST),
          {' '}<span className="text-cyan-400">List USD</span> (shown on the marketing website), and
          {' '}<span className="text-amber-400">Partner INR</span> (wholesale rate TrackForce charges partners).
        </p>
        <button onClick={() => setEditing({ billing_cycle: 'yearly', is_active: true, seat_count: 5, price_inr: 10000, partner_price_inr: 7000 })}
          className="px-3 py-1.5 text-xs rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium">
          + New Plan
        </button>
      </div>
      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Code</th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-right">Seats</th>
              <th className="px-4 py-3 text-right">List ₹</th>
              <th className="px-4 py-3 text-right">List $</th>
              <th className="px-4 py-3 text-right">Partner ₹</th>
              <th className="px-4 py-3 text-right">Margin</th>
              <th className="px-4 py-3 text-left">Cycle</th>
              <th className="px-4 py-3 text-left">Active</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={10} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {rows.map((p) => {
              const margin = Number(p.price_inr) - Number(p.partner_price_inr);
              const marginPct = Number(p.price_inr) > 0 ? Math.round((margin / Number(p.price_inr)) * 100) : 0;
              return (
              <tr key={p.id} className="hover:bg-dark-700/30">
                <td className="px-4 py-3 text-cyan-400 font-mono text-xs">{p.code}</td>
                <td className="px-4 py-3 text-white">{p.name}</td>
                <td className="px-4 py-3 text-right text-gray-300">{p.seat_count}</td>
                <td className="px-4 py-3 text-right text-white">₹{Number(p.price_inr).toLocaleString('en-IN')}</td>
                <td className="px-4 py-3 text-right text-cyan-300">{p.price_usd != null ? `$${Number(p.price_usd).toLocaleString('en-US')}` : <span className="text-gray-600">—</span>}</td>
                <td className="px-4 py-3 text-right text-amber-300">₹{Number(p.partner_price_inr).toLocaleString('en-IN')}</td>
                <td className="px-4 py-3 text-right text-emerald-400 text-xs">
                  ₹{margin.toLocaleString('en-IN')} <span className="text-gray-500">({marginPct}%)</span>
                </td>
                <td className="px-4 py-3 text-gray-400 capitalize">{p.billing_cycle}</td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleActive(p)} className={`px-2 py-0.5 text-[10px] rounded-md border ${p.is_active ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-gray-500/15 text-gray-400 border-gray-500/30'}`}>
                    {p.is_active ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setEditing(p)} className="text-cyan-400 hover:text-cyan-300 text-xs">Edit</button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="max-w-md w-full bg-dark-800 border border-dark-700 rounded-xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-dark-700 flex items-center justify-between">
              <h2 className="text-white font-semibold">{editing.id ? 'Edit Plan' : 'New Plan'}</h2>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-white"><i className="ri-close-line text-lg" /></button>
            </div>
            <div className="p-5 space-y-3">
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <Field label="Code (e.g. starter-5)"><input value={editing.code ?? ''} onChange={(e) => setEditing({ ...editing, code: e.target.value })} className={input} /></Field>
              <Field label="Name"><input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={input} /></Field>
              <Field label="Description"><textarea value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} rows={2} className={input} /></Field>
              <Field label="Seats"><input type="number" min={1} value={editing.seat_count ?? ''} onChange={(e) => setEditing({ ...editing, seat_count: parseInt(e.target.value, 10) })} className={input} /></Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="List ₹ (invoicing/GST)">
                  <input type="number" min={0} step="0.01" value={editing.price_inr ?? ''}
                    onChange={(e) => setEditing({ ...editing, price_inr: parseFloat(e.target.value) })} className={input} />
                </Field>
                <Field label="List $ (website)">
                  <input type="number" min={0} step="0.01" value={editing.price_usd ?? ''}
                    onChange={(e) => setEditing({ ...editing, price_usd: e.target.value === '' ? null : parseFloat(e.target.value) })} className={input} />
                </Field>
                <Field label="Partner ₹ (wholesale)">
                  <input type="number" min={0} step="0.01" value={editing.partner_price_inr ?? ''}
                    onChange={(e) => setEditing({ ...editing, partner_price_inr: parseFloat(e.target.value) })} className={input} />
                </Field>
              </div>
              {editing.price_inr && editing.partner_price_inr ? (
                <p className="text-[11px] text-emerald-400 -mt-1">
                  Partner margin per cycle: ₹{(Number(editing.price_inr) - Number(editing.partner_price_inr)).toLocaleString('en-IN')}
                  {' '}({Math.round(((Number(editing.price_inr) - Number(editing.partner_price_inr)) / Number(editing.price_inr)) * 100)}%)
                </p>
              ) : null}
              <Field label="Billing Cycle">
                <select value={editing.billing_cycle ?? 'yearly'} onChange={(e) => setEditing({ ...editing, billing_cycle: e.target.value as 'monthly' | 'yearly' })} className={input}>
                  <option value="yearly">Yearly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </Field>
              <button onClick={save} className="w-full mt-2 bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium py-2.5 rounded-lg">Save</button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

const input = 'w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500';
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</span><div className="mt-1">{children}</div></label>;
}
