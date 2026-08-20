import { useEffect, useState } from 'react';
import { supabase, type LicenseStatus } from '@/lib/supabase';
import { confirmDialog, notify, promptDialog } from '@/lib/notify';

type LicenseRow = {
  id: string;
  license_key: string;
  organization_id: string;
  partner_id: string | null;
  seat_count: number;
  status: LicenseStatus;
  issued_at: string;
  expires_at: string;
  organizations: { name: string } | null;
  partners: { name: string } | null;
  plans: { name: string; code: string } | null;
};

const statusColor: Record<string, string> = {
  active:          'bg-green-500/15 text-green-400 border-green-500/30',
  suspended:       'bg-orange-500/15 text-orange-400 border-orange-500/30',
  expired:         'bg-red-500/15 text-red-400 border-red-500/30',
  revoked:         'bg-red-700/30 text-red-300 border-red-600/40',
  pending_payment: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  trial:           'bg-blue-500/15 text-blue-300 border-blue-500/30',
};

interface Props {
  scope: 'super_admin' | 'partner';
  partnerId?: string | null;
}

export default function LicensesTable({ scope, partnerId }: Props) {
  const [rows, setRows] = useState<LicenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | LicenseStatus>('all');
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  const load = async () => {
    setLoading(true);
    let q = supabase
      .from('licenses')
      .select('id,license_key,organization_id,partner_id,seat_count,status,issued_at,expires_at,organizations(name),partners(name),plans(name,code)')
      .order('issued_at', { ascending: false });
    if (scope === 'partner' && partnerId) q = q.eq('partner_id', partnerId);
    if (filter !== 'all') q = q.eq('status', filter);
    const { data, error } = await q;
    if (error) setError(error.message);
    setRows((data as unknown as LicenseRow[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [filter, partnerId, scope]);

  const bill = async (id: string) => {
    setBusy(id); setError(null);
    const { data, error } = await supabase.rpc('create_invoice_for_license', {
      p_license_id: id, p_due_days: 7, p_notes: null,
    });
    if (error) { setError(error.message); setBusy(null); return; }
    const row = Array.isArray(data) ? data[0] : data;
    setBusy(null);
    if (row) {
      notify.success(`Invoice ${row.invoice_number} created`, {
        description:
          `₹${Number(row.total_inr).toLocaleString('en-IN')} — go to Invoices to pay or share it with the customer.`,
      });
    }
  };

  const setStatus = async (id: string, status: LicenseStatus, reason?: string) => {
    setBusy(id); setError(null);
    const { error } = await supabase.rpc('set_license_status', {
      p_license_id: id, p_status: status, p_reason: reason ?? null,
    });
    if (error) setError(error.message); else await load();
    setBusy(null);
  };

  // Manual extension (super_admin only). Two modes: by N billing periods, or
  // to a custom expiry date. Both flow through extend_license_renewal which
  // also flips the org back to active if it was trial/expired/suspended.
  const extend = async (id: string) => {
    const periodsStr = await promptDialog({
      title: 'Extend renewal by how many billing periods?',
      body: 'On a monthly plan "1" adds one month; on a yearly plan it adds one year. Leave blank to set a custom expiry date instead.',
      defaultValue: '1',
      placeholder: '1',
      confirmLabel: 'Continue',
    });
    if (periodsStr === null) return;
    let untilArg: string | null = null;
    let periodsArg = 1;
    if (periodsStr.trim() === '') {
      const customDate = await promptDialog({
        title: 'New expiry date',
        body: 'Enter the date the licence should run until.',
        placeholder: 'YYYY-MM-DD',
      });
      if (!customDate) return;
      const d = new Date(customDate);
      if (Number.isNaN(d.getTime())) {
        notify.error('That date could not be read', { description: 'Use the format YYYY-MM-DD.' });
        return;
      }
      untilArg = d.toISOString();
    } else {
      const n = parseInt(periodsStr, 10);
      if (!Number.isFinite(n) || n < 1) {
        notify.error('That is not a valid number of periods', { description: 'Enter a whole number of 1 or more.' });
        return;
      }
      periodsArg = n;
    }
    const ok = await confirmDialog({
      title: untilArg
        ? `Extend renewal until ${new Date(untilArg).toDateString()}?`
        : `Extend renewal by ${periodsArg} period${periodsArg === 1 ? '' : 's'}?`,
      body: 'The licence status will be set to active.',
      confirmLabel: 'Extend renewal',
    });
    if (!ok) return;
    setBusy(id); setError(null);
    const { error } = await supabase.rpc('extend_license_renewal', {
      p_license_id: id, p_periods: periodsArg, p_until: untilArg,
    });
    if (error) {
      setError(error.message);
      notify.fail('Could not extend the renewal', error);
    } else {
      notify.success('Renewal extended', { description: 'The licence is now active.' });
      await load();
    }
    setBusy(null);
  };

  const copy = async (key: string) => {
    await navigator.clipboard.writeText(key);
  };

  const filters: Array<'all' | LicenseStatus> = ['all', 'active', 'suspended', 'expired', 'revoked'];

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
              <th className="px-4 py-3 text-left">Customer</th>
              {scope === 'super_admin' && <th className="px-4 py-3 text-left">Partner</th>}
              <th className="px-4 py-3 text-left">Plan</th>
              <th className="px-4 py-3 text-left">Seats</th>
              <th className="px-4 py-3 text-left">License Key</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Expires</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={scope === 'super_admin' ? 8 : 7} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={scope === 'super_admin' ? 8 : 7} className="px-4 py-6 text-center text-gray-500 text-xs">No licenses</td></tr>
            )}
            {rows.map((l) => {
              const shown = reveal[l.id];
              const masked = `${l.license_key.slice(0, 8)}…${l.license_key.slice(-4)}`;
              return (
                <tr key={l.id} className="hover:bg-dark-700/30">
                  <td className="px-4 py-3 text-white">{l.organizations?.name ?? '—'}</td>
                  {scope === 'super_admin' && (
                    <td className="px-4 py-3 text-gray-400">{l.partners?.name ?? <span className="text-gray-600">— direct —</span>}</td>
                  )}
                  <td className="px-4 py-3 text-gray-300">{l.plans?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-300">{l.seat_count}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <code className="text-cyan-400 text-[11px] font-mono">{shown ? l.license_key : masked}</code>
                      <button onClick={() => setReveal((s) => ({ ...s, [l.id]: !s[l.id] }))} className="text-gray-500 hover:text-gray-300 text-xs">
                        <i className={shown ? 'ri-eye-off-line' : 'ri-eye-line'} />
                      </button>
                      <button onClick={() => copy(l.license_key)} className="text-gray-500 hover:text-gray-300 text-xs">
                        <i className="ri-file-copy-line" />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 text-[10px] rounded-md border capitalize ${statusColor[l.status]}`}>{l.status}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-[11px]">
                    {new Date(l.expires_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1.5 flex-wrap">
                      {scope === 'super_admin' && l.status !== 'revoked' && (
                        <button
                          onClick={() => extend(l.id)}
                          disabled={busy === l.id}
                          title="Manually extend renewal by N billing cycles or to a custom date. Use this for cash/cheque payments where Razorpay didn't auto-renew."
                          className="px-2 py-1 text-[11px] rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 disabled:opacity-50"
                        >
                          Extend
                        </button>
                      )}
                      {l.status === 'active' && (
                        <button onClick={() => setStatus(l.id, 'suspended')} disabled={busy === l.id}
                          className="px-2 py-1 text-[11px] rounded bg-orange-600/20 text-orange-400 border border-orange-600/30 hover:bg-orange-600/30 disabled:opacity-50">
                          Suspend
                        </button>
                      )}
                      {(l.status === 'suspended' || l.status === 'expired') && (
                        <button onClick={() => setStatus(l.id, 'active')} disabled={busy === l.id}
                          className="px-2 py-1 text-[11px] rounded bg-green-600/20 text-green-400 border border-green-600/30 hover:bg-green-600/30 disabled:opacity-50">
                          Reactivate
                        </button>
                      )}
                      {(l.status === 'active' || l.status === 'expired') && (
                        <button
                          onClick={() => bill(l.id)}
                          disabled={busy === l.id}
                          title="Generate a Razorpay invoice for this license. When the customer pays, the license auto-extends by 1 billing cycle."
                          className="px-2 py-1 text-[11px] rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/30 disabled:opacity-50">
                          Bill
                        </button>
                      )}
                      {l.status !== 'revoked' && (
                        <button
                          onClick={async () => {
                            const r = await promptDialog({
                              title: `Revoke licence ${l.license_key}?`,
                              body: 'The agents on this licence stop reporting immediately. Give a reason for the audit trail.',
                              placeholder: 'Reason for revocation',
                              confirmLabel: 'Revoke licence',
                            });
                            if (r !== null) await setStatus(l.id, 'revoked', r);
                          }}
                          disabled={busy === l.id}
                          className="px-2 py-1 text-[11px] rounded bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30 disabled:opacity-50">
                          Revoke
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
