import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../AdminLayout';
import { supabase, type Partner, type PartnerStatus } from '@/lib/supabase';
import RegisterPartnerModal from '@/components/billing/RegisterPartnerModal';
import { confirmDialog, promptDialog } from '@/lib/notify';

const statusColor: Record<PartnerStatus, string> = {
  pending:   'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  active:    'bg-green-500/15 text-green-400 border-green-500/30',
  suspended: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  rejected:  'bg-red-500/15 text-red-400 border-red-500/30',
};

export default function AdminPartners() {
  const [rows, setRows] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | PartnerStatus>('all');
  const [error, setError] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    let q = supabase.from('partners').select('*').order('created_at', { ascending: false });
    if (filter !== 'all') q = q.eq('status', filter);
    const { data, error } = await q;
    if (error) setError(error.message);
    setRows((data as Partner[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [filter]);

  const callApprove = async (partnerId: string) => {
    setBusy(partnerId);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/approve-partner`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ partner_id: partnerId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approval failed');
    } finally {
      setBusy(null);
    }
  };

  const reject = async (partnerId: string) => {
    const reason = await promptDialog({ title: 'Reason for rejection?' }) ?? '';
    setBusy(partnerId);
    const { error } = await supabase.from('partners').update({ status: 'rejected', rejection_reason: reason }).eq('id', partnerId);
    if (error) setError(error.message); else await load();
    setBusy(null);
  };

  const suspend = async (partnerId: string, status: 'suspended' | 'active') => {
    setBusy(partnerId);
    const { error } = await supabase.from('partners').update({ status }).eq('id', partnerId);
    if (error) setError(error.message); else await load();
    setBusy(null);
  };

  const resetPassword = async (p: Partner) => {
    if (!await confirmDialog({ title: `Send password-reset email to ${p.contact_email}?`, tone: 'danger' })) return;
    setBusy(p.id);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(p.contact_email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) setError(`Reset failed: ${error.message}`);
    setBusy(null);
  };

  const deletePartner = async (p: Partner) => {
    if (!await confirmDialog({ title: `Delete partner "${p.name}"? This will detach all customers/licenses linked to them. Auth users + their data are NOT deleted.`, tone: 'danger' })) return;
    setBusy(p.id); setError(null);
    const { error } = await supabase.from('partners').delete().eq('id', p.id);
    if (error) setError(`Delete failed: ${error.message}`);
    else await load();
    setBusy(null);
  };

  const resendInvite = async (p: Partner) => {
    setBusy(p.id);
    setError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const jwt = sess.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-invite-partner`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          partner_id: p.id,
          email: p.contact_email,
          full_name: p.contact_person,
        }),
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

  const filters: Array<'all' | PartnerStatus> = ['all', 'pending', 'active', 'suspended', 'rejected'];

  return (
    <AdminLayout title="Partners">
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors capitalize ${
                filter === f ? 'bg-dark-700 text-white' : 'bg-dark-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          onClick={() => setRegisterOpen(true)}
          className="px-3 py-1.5 text-xs rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 font-medium flex items-center gap-1.5"
        >
          <i className="ri-add-line text-sm" /> Register Partner
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Partner</th>
              <th className="px-4 py-3 text-left">Contact</th>
              <th className="px-4 py-3 text-left">GST</th>
              <th className="px-4 py-3 text-left">Commission</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Joined</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500 text-xs">No partners</td></tr>
            )}
            {rows.map((p) => (
              <tr key={p.id} className="hover:bg-dark-700/30">
                <td className="px-4 py-3 text-white">
                  <Link to={`/admin/partners/${p.id}`} className="hover:text-cyan-400">{p.name}</Link>
                </td>
                <td className="px-4 py-3 text-gray-400">
                  <div>{p.contact_email}</div>
                  {p.phone && <div className="text-[11px] text-gray-600">{p.phone}</div>}
                </td>
                <td className="px-4 py-3 text-gray-500 text-[11px]">{p.gst_number ?? '—'}</td>
                <td className="px-4 py-3 text-gray-300">{p.commission_pct}%</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 text-[10px] rounded-md border ${statusColor[p.status]} capitalize`}>
                    {p.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-[11px]">
                  {new Date(p.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2 flex-wrap">
                    <Link
                      to={`/admin/partners/${p.id}`}
                      className="px-3 py-1 text-[11px] rounded bg-dark-700 text-gray-300 border border-dark-600 hover:bg-dark-600 hover:text-white"
                    >
                      View
                    </Link>
                    {(p.status === 'active' || p.status === 'pending') && (
                      <button
                        onClick={() => resendInvite(p)}
                        disabled={busy === p.id}
                        title="Send a fresh magic-link invite to the partner's contact email"
                        className="px-3 py-1 text-[11px] rounded bg-violet-600/15 text-violet-400 border border-violet-600/30 hover:bg-violet-600/25 disabled:opacity-50"
                      >
                        {busy === p.id ? '…' : 'Resend Invite'}
                      </button>
                    )}
                    <button
                      onClick={() => resetPassword(p)}
                      disabled={busy === p.id}
                      title="Email a password-reset link to the partner's contact email"
                      className="px-3 py-1 text-[11px] rounded bg-cyan-600/15 text-cyan-400 border border-cyan-600/30 hover:bg-cyan-600/25 disabled:opacity-50"
                    >
                      Reset Pwd
                    </button>
                    <button
                      onClick={() => deletePartner(p)}
                      disabled={busy === p.id}
                      title="Permanently delete this partner row"
                      className="px-3 py-1 text-[11px] rounded bg-red-600/15 text-red-400 border border-red-600/30 hover:bg-red-600/25 disabled:opacity-50"
                    >
                      Delete
                    </button>
                    {p.status === 'pending' && (
                      <>
                        <button
                          onClick={() => callApprove(p.id)}
                          disabled={busy === p.id}
                          className="px-3 py-1 text-[11px] rounded bg-green-600/20 text-green-400 border border-green-600/30 hover:bg-green-600/30 disabled:opacity-50"
                        >
                          {busy === p.id ? '…' : 'Approve'}
                        </button>
                        <button
                          onClick={() => reject(p.id)}
                          disabled={busy === p.id}
                          className="px-3 py-1 text-[11px] rounded bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {p.status === 'active' && (
                      <button
                        onClick={() => suspend(p.id, 'suspended')}
                        disabled={busy === p.id}
                        className="px-3 py-1 text-[11px] rounded bg-orange-600/20 text-orange-400 border border-orange-600/30 hover:bg-orange-600/30 disabled:opacity-50"
                      >
                        Suspend
                      </button>
                    )}
                    {p.status === 'suspended' && (
                      <button
                        onClick={() => suspend(p.id, 'active')}
                        disabled={busy === p.id}
                        className="px-3 py-1 text-[11px] rounded bg-green-600/20 text-green-400 border border-green-600/30 hover:bg-green-600/30 disabled:opacity-50"
                      >
                        Reactivate
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <RegisterPartnerModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onCreated={load}
      />
    </AdminLayout>
  );
}
