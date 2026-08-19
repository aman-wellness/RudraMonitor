// /admin/users — Super-admin user management. Lets an existing super_admin
// invite new super_admins, revoke access, and see who else has admin keys to
// the platform. Wraps the `admin-users-manage` edge function + the
// `list_super_admins` SECURITY DEFINER RPC.

import { useEffect, useState } from 'react';
import AdminLayout from '../AdminLayout';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { confirmDialog } from '@/lib/notify';

type Row = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  granted_at: string;
  last_sign_in_at: string | null;
  is_disabled: boolean | null;
};

export default function AdminUsersPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('list_super_admins');
    if (error) setMsg({ kind: 'err', text: error.message });
    else setRows((data as Row[]) ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const callFn = async (body: Record<string, unknown>) => {
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-users-manage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };

  const submitInvite = async () => {
    if (!inviteEmail.includes('@')) { setMsg({ kind: 'err', text: 'Valid email required' }); return; }
    setBusy('invite'); setMsg(null);
    try {
      const j = await callFn({ action: 'invite', email: inviteEmail.trim(), full_name: inviteName.trim() || undefined });
      const text = j.status === 'invited'
        ? `Invite sent to ${inviteEmail}. They'll be a super_admin once they sign in.`
        : `${inviteEmail} already had an account — granted super_admin access.`;
      setMsg({ kind: 'ok', text });
      setInviteEmail(''); setInviteName(''); setInviteOpen(false);
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(null); }
  };

  const runAction = async (r: Row, action: 'revoke' | 'reset_password' | 'disable' | 'enable' | 'delete', confirmMsg: string, okMsg: string) => {
    if (!await confirmDialog({ title: confirmMsg })) return;
    setBusy(`${r.user_id}-${action}`); setMsg(null);
    try {
      await callFn({ action, user_id: r.user_id });
      setMsg({ kind: 'ok', text: okMsg });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(null); }
  };

  const revoke = (r: Row) => runAction(r, 'revoke',
    `Revoke super_admin access for ${r.email ?? r.user_id}? They'll lose platform admin access immediately. (Account is kept active for non-admin use.)`,
    `Revoked super_admin from ${r.email}`);

  const resetPassword = (r: Row) => runAction(r, 'reset_password',
    `Send password reset email to ${r.email}?`,
    `Password reset email sent to ${r.email}`);

  const disable = (r: Row) => runAction(r, 'disable',
    `Disable sign-in for ${r.email}? They won't be able to log in until you re-enable.`,
    `Disabled sign-in for ${r.email}`);

  const enable = (r: Row) => runAction(r, 'enable',
    `Re-enable sign-in for ${r.email}?`,
    `Sign-in re-enabled for ${r.email}`);

  const deleteUser = (r: Row) => runAction(r, 'delete',
    `Permanently DELETE ${r.email}? This removes their auth account entirely — they will need a fresh invite to come back. Continue?`,
    `Deleted ${r.email}`);

  return (
    <AdminLayout title="Admin Users">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <p className="text-sm text-gray-400 max-w-2xl">
            Users with super-admin access to the Rudrans platform. They can manage every partner, customer, plan, integration, and invoice.
          </p>
        </div>
        <button
          onClick={() => setInviteOpen((v) => !v)}
          className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium flex items-center gap-1.5 shrink-0"
        >
          <i className="ri-user-add-line" />
          {inviteOpen ? 'Cancel' : 'Invite admin'}
        </button>
      </div>

      {msg && (
        <div className={`mb-3 px-3 py-2 rounded-lg text-xs border ${
          msg.kind === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
        }`}>{msg.text}</div>
      )}

      {inviteOpen && (
        <div className="mb-4 bg-dark-800 border border-dark-700 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-white">Invite a new super-admin</h3>
          <p className="text-[11px] text-gray-500">
            If the email already has a Rudrans account, we'll grant them super_admin instantly.
            Otherwise we'll send a signup invite and pre-stage the role for first login.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="email" placeholder="email@yourcompany.com" value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="px-3 py-2 rounded-lg bg-dark-900 border border-dark-700 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/50"
            />
            <input
              type="text" placeholder="Full name (optional)" value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              className="px-3 py-2 rounded-lg bg-dark-900 border border-dark-700 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/50"
            />
          </div>
          <button
            onClick={submitInvite} disabled={busy === 'invite' || !inviteEmail.includes('@')}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium"
          >
            {busy === 'invite' ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      )}

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Email</th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Granted</th>
              <th className="px-4 py-3 text-left">Last sign-in</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500 text-xs">No super-admins. Use the secret /super login route to bootstrap.</td></tr>
            )}
            {rows.map((r) => {
              const isSelf = r.user_id === user?.id;
              const rowBusy = (a: string) => busy === `${r.user_id}-${a}`;
              const anyBusy = !!busy && busy.startsWith(r.user_id);
              return (
                <tr key={r.user_id} className="hover:bg-dark-700/30">
                  <td className="px-4 py-3 text-white">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{r.email ?? <span className="text-gray-600">—</span>}</span>
                      {isSelf && <span className="px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider border bg-cyan-500/15 text-cyan-300 border-cyan-500/30">You</span>}
                      {r.is_disabled && <span className="px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-wider border bg-rose-500/15 text-rose-300 border-rose-500/30">Disabled</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-300">{r.full_name || <span className="text-gray-600">—</span>}</td>
                  <td className="px-4 py-3 text-gray-500 text-[11px]">
                    {new Date(r.granted_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-[11px]">
                    {r.last_sign_in_at
                      ? new Date(r.last_sign_in_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
                      : <span className="text-amber-300">Pending invite</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5 flex-wrap">
                      <button
                        onClick={() => resetPassword(r)} disabled={anyBusy || !r.email}
                        className="px-2.5 py-1 text-[11px] rounded-md bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-40"
                        title="Send password reset email"
                      >
                        {rowBusy('reset_password') ? '…' : 'Reset PW'}
                      </button>
                      {r.is_disabled ? (
                        <button
                          onClick={() => enable(r)} disabled={anyBusy}
                          className="px-2.5 py-1 text-[11px] rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-40"
                          title="Re-enable sign-in"
                        >
                          {rowBusy('enable') ? '…' : 'Enable'}
                        </button>
                      ) : (
                        <button
                          onClick={() => disable(r)} disabled={anyBusy || isSelf}
                          className="px-2.5 py-1 text-[11px] rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 disabled:opacity-40"
                          title={isSelf ? "Can't disable yourself" : 'Block sign-in (account kept)'}
                        >
                          {rowBusy('disable') ? '…' : 'Disable'}
                        </button>
                      )}
                      <button
                        onClick={() => revoke(r)} disabled={anyBusy || isSelf}
                        className="px-2.5 py-1 text-[11px] rounded-md bg-rose-500/10 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20 disabled:opacity-40"
                        title={isSelf ? "Can't revoke yourself" : 'Drop super_admin role (account stays)'}
                      >
                        {rowBusy('revoke') ? '…' : 'Revoke'}
                      </button>
                      <button
                        onClick={() => deleteUser(r)} disabled={anyBusy || isSelf}
                        className="px-2.5 py-1 text-[11px] rounded-md bg-rose-500/20 text-rose-200 border border-rose-500/40 hover:bg-rose-500/30 disabled:opacity-40"
                        title={isSelf ? "Can't delete yourself" : 'Permanently delete auth account'}
                      >
                        {rowBusy('delete') ? '…' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-gray-500">
        Super-admins have full access to every customer's data. Only invite people you trust.
      </p>
    </AdminLayout>
  );
}
