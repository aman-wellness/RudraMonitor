import { useEffect, useState } from 'react';
import AdminLayout from '../AdminLayout';
import { supabase } from '@/lib/supabase';

/**
 * Super-admin editor for the SaaS vendor's own company info — the "Bill From"
 * entity that appears on every customer invoice. RLS lets super-admins
 * UPDATE only this singleton row; all callers READ it.
 */
type Row = {
  id: number;
  legal_name: string;
  brand_name: string | null;
  gst_number: string | null;
  pan_number: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string;
  contact_email: string | null;
  phone: string | null;
  website: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  invoice_prefix: string;
  invoice_next_number: number;
  updated_at: string;
};

const FIELDS: Array<{ key: keyof Row; label: string; type?: 'text' | 'email' | 'tel'; mono?: boolean; cols?: 1 | 2 | 3 }> = [
  { key: 'legal_name', label: 'Legal Name', cols: 2 },
  { key: 'brand_name', label: 'Brand Name (shown on UI)', cols: 1 },
  { key: 'gst_number', label: 'GSTIN', mono: true },
  { key: 'pan_number', label: 'PAN', mono: true },
  { key: 'address_line1', label: 'Address Line 1', cols: 3 },
  { key: 'address_line2', label: 'Address Line 2', cols: 3 },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'postal_code', label: 'Pincode', mono: true },
  { key: 'country', label: 'Country' },
  { key: 'contact_email', label: 'Billing Email', type: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel' },
  { key: 'website', label: 'Website' },
  { key: 'bank_name', label: 'Bank Name' },
  { key: 'bank_account_number', label: 'Bank A/c #', mono: true },
  { key: 'bank_ifsc', label: 'IFSC', mono: true },
  { key: 'invoice_prefix', label: 'Invoice Prefix (e.g. RDR)', mono: true },
];

export default function BillingEntityPage() {
  const [row, setRow] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = async () => {
    setLoading(true); setMsg(null);
    const { data, error } = await supabase
      .from('billing_entity').select('*').eq('id', 1).maybeSingle();
    if (error) { setMsg({ kind: 'err', text: error.message }); setLoading(false); return; }
    setRow(data as Row); setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const save = async () => {
    if (!row) return;
    setSaving(true); setMsg(null);
    // Don't send invoice_next_number (server-managed) — only the editable fields.
    const updates: Partial<Row> = {};
    FIELDS.forEach((f) => {
      const v = row[f.key];
      // @ts-expect-error narrowing on dynamic key
      updates[f.key] = typeof v === 'string' ? (v.trim() || null) : v;
    });
    const { error } = await supabase.from('billing_entity').update(updates).eq('id', 1);
    setSaving(false);
    if (error) setMsg({ kind: 'err', text: error.message });
    else { setMsg({ kind: 'ok', text: 'Saved. New invoices will use these details immediately.' }); void load(); }
  };

  return (
    <AdminLayout title="Billing Entity">
      <div className="max-w-3xl">
        <h2 className="text-base font-semibold text-white mb-1">Your company info</h2>
        <p className="text-xs text-gray-500 mb-5">
          This is the "Bill From" entity printed on every customer invoice. Make sure your GSTIN, address and bank details are accurate before customers pay.
        </p>

        {msg && (
          <div className={`mb-4 px-3 py-2 rounded-lg text-xs border ${
            msg.kind === 'ok' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}>{msg.text}</div>
        )}

        {loading || !row ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="bg-dark-800 border border-dark-700 rounded-2xl p-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {FIELDS.map((f) => (
                <div key={String(f.key)} className={f.cols === 3 ? 'md:col-span-3' : f.cols === 2 ? 'md:col-span-2' : ''}>
                  <label className="block text-[11px] text-gray-400 uppercase tracking-wider mb-1.5">{f.label}</label>
                  <input
                    type={f.type ?? 'text'}
                    value={String(row[f.key] ?? '')}
                    onChange={(e) => setRow({ ...row, [f.key]: e.target.value } as Row)}
                    className={`w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 ${f.mono ? 'font-mono' : ''}`}
                  />
                </div>
              ))}
            </div>

            <div className="mt-5 flex items-center justify-between">
              <p className="text-[11px] text-gray-500">
                Next invoice will be <span className="font-mono text-gray-300">{row.invoice_prefix}-{new Date().getFullYear()}-{String(row.invoice_next_number).padStart(6, '0')}</span>
              </p>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-dark-950 font-medium text-xs px-4 py-2 rounded-md"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
