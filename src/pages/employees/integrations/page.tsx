import { useCallback, useEffect, useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';
import { confirmDialog } from '@/lib/notify';

type OrgIntegration = {
  id: string;
  org_id: string;
  provider: 'm365' | 'google';
  tenant_id: string | null;
  primary_domain: string | null;
  impersonate_subject: string | null;
  connected_by_email: string | null;
  scopes: string[];
  status: 'pending' | 'active' | 'syncing' | 'error' | 'disconnected';
  status_detail: string | null;
  last_sync_at: string | null;
  last_sync_error: string | null;
};

export default function EmployeesIntegrations() {
  const [rows, setRows] = useState<OrgIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'m365' | 'google' | 'sync' | 'disconnect-m365' | 'disconnect-google' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [m365Tenant, setM365Tenant] = useState('');
  const [m365Domain, setM365Domain] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('org_integrations_safe')
      .select('*')
      .in('provider', ['m365', 'google']);
    if (!error) setRows((data ?? []) as OrgIntegration[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-poll while any integration row is in 'syncing' so the UI updates
  // without requiring a manual refresh. Sync runs in the background on the
  // server (EdgeRuntime.waitUntil) — navigating away doesn't cancel it.
  useEffect(() => {
    const anySyncing = rows.some((r) => r.status === 'syncing');
    if (!anySyncing) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [rows, load]);

  const m365 = rows.find((r) => r.provider === 'm365');
  const google = rows.find((r) => r.provider === 'google');

  const callFn = async (name: string, body: Record<string, unknown>) => {
    const { data: { session } } = await supabase.auth.getSession();
    const r = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `${r.status}`);
    return j;
  };

  const startM365Consent = async () => {
    // Get our app's client_id + redirect_uri from public integrations probe (non-secret).
    // For now we use a known constant from env; the multi-tenant app's client_id is shared.
    const clientId = (import.meta.env.VITE_M365_DIRECTORY_CLIENT_ID as string | undefined) || '';
    const redirect = window.location.origin + '/employees/integrations';
    if (!clientId) {
      setMsg({ kind: 'err', text: 'VITE_M365_DIRECTORY_CLIENT_ID missing in .env' });
      return;
    }
    const state = crypto.randomUUID();
    sessionStorage.setItem('m365_consent_state', state);
    const url =
      `https://login.microsoftonline.com/common/adminconsent` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&state=${encodeURIComponent(state)}`;
    window.location.href = url;
  };

  // After admin-consent return, MSFT redirects with ?tenant=...&admin_consent=True&state=...
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const tenant = q.get('tenant');
    const consent = q.get('admin_consent');
    const state = q.get('state');
    const stored = sessionStorage.getItem('m365_consent_state');
    if (!tenant || consent !== 'True') return;
    if (state !== stored) {
      setMsg({ kind: 'err', text: 'State mismatch — try connecting again' });
      return;
    }
    sessionStorage.removeItem('m365_consent_state');
    (async () => {
      setBusy('m365'); setMsg(null);
      try {
        await callFn('oauth-m365-callback', { tenant_id: tenant });
        setMsg({ kind: 'ok', text: 'Microsoft 365 connected. Run sync next.' });
        window.history.replaceState({}, '', window.location.pathname);
        await load();
      } catch (e) {
        setMsg({ kind: 'err', text: (e as Error).message });
      } finally { setBusy(null); }
    })();
  }, [load]);

  // After Google admin-consent return: Google redirects with ?code=...&state=...
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get('code');
    const state = q.get('state');
    const stored = sessionStorage.getItem('google_consent_state');
    const scope = q.get('scope') ?? '';
    // Only handle if the state matches OUR Google consent (avoids running
    // on the M365 callback or unrelated redirects).
    if (!code || !state || state !== stored) return;
    if (!scope.includes('admin.directory')) return;
    sessionStorage.removeItem('google_consent_state');
    (async () => {
      setBusy('google'); setMsg(null);
      try {
        const redirect = window.location.origin + '/employees/integrations';
        await callFn('oauth-google-callback', { code, redirect_uri: redirect });
        setMsg({ kind: 'ok', text: 'Google Workspace connected. Run sync next.' });
        window.history.replaceState({}, '', window.location.pathname);
        await load();
      } catch (e) {
        setMsg({ kind: 'err', text: (e as Error).message });
      } finally { setBusy(null); }
    })();
  }, [load]);

  const connectM365Manual = async () => {
    if (!m365Tenant.trim()) { setMsg({ kind: 'err', text: 'Tenant ID required' }); return; }
    setBusy('m365'); setMsg(null);
    try {
      await callFn('oauth-m365-callback', { tenant_id: m365Tenant.trim(), primary_domain: m365Domain.trim() || undefined });
      setMsg({ kind: 'ok', text: 'Microsoft 365 connected.' });
      setM365Tenant(''); setM365Domain('');
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(null); }
  };

  // One-click OAuth: redirect to Google for admin consent. Same pattern as
  // M365 — Google sends the browser back here with ?code=… which the
  // useEffect below picks up and exchanges for tokens via oauth-google-callback.
  const startGoogleConsent = async () => {
    const clientId = (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined) || '';
    const redirect = window.location.origin + '/employees/integrations';
    if (!clientId) {
      setMsg({ kind: 'err', text: 'VITE_GOOGLE_OAUTH_CLIENT_ID missing in .env — Rudrans setup incomplete' });
      return;
    }
    const state = crypto.randomUUID();
    sessionStorage.setItem('google_consent_state', state);
    const scopes = [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/admin.directory.user',
      'https://www.googleapis.com/auth/admin.directory.group',
      'https://www.googleapis.com/auth/admin.directory.group.member',
      'https://www.googleapis.com/auth/admin.directory.domain.readonly',
      'https://www.googleapis.com/auth/admin.directory.orgunit',
      'https://www.googleapis.com/auth/gmail.send',
    ].join(' ');
    const url =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&access_type=offline` +
      `&prompt=consent` +
      `&include_granted_scopes=true` +
      `&state=${encodeURIComponent(state)}`;
    window.location.href = url;
  };

  const runSync = async (provider: 'm365' | 'google' | 'all') => {
    setBusy('sync'); setMsg(null);
    try {
      const j = await callFn('directory-sync', { provider });
      setMsg({ kind: 'ok', text: `Synced: ${JSON.stringify(j[provider === 'all' ? 'm365' : provider] ?? j)}` });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(null); }
  };

  const disconnect = async (provider: 'm365' | 'google') => {
    const label = provider === 'm365' ? 'Microsoft 365' : 'Google Workspace';
    if (!await confirmDialog({ title: `Disconnect ${label}?\n\n` +
      `This wipes ALL synced users, groups, and team memberships for ${label} from Rudrans. ` +
      `Reconnecting and re-syncing will re-populate them. Continue?`, tone: 'danger' })) return;
    setBusy(provider === 'm365' ? 'disconnect-m365' : 'disconnect-google');
    setMsg(null);
    try {
      await callFn('directory-disconnect', { provider });
      setMsg({ kind: 'ok', text: `${label} disconnected. All synced data cleared.` });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">
            Directory Integrations
          </h1>
          <p className="text-sm text-gray-400">
            Connect Microsoft 365 and Google Workspace. Once connected, users, groups, teams, and shared mailboxes sync into Rudrans and every change you make here flows back to the provider.
          </p>
        </header>

        {msg && (
          <div className={`mb-5 px-4 py-3 rounded-lg text-sm border ${msg.kind === 'ok' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-300'}`}>
            {msg.text}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Microsoft 365 */}
          <section className="bg-dark-800 border border-dark-700 rounded-xl p-5">
            <header className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-lg bg-blue-500/15 text-blue-400 flex items-center justify-center">
                  <i className="ri-microsoft-line text-xl" />
                </span>
                <div>
                  <h2 className="text-white font-semibold">Microsoft 365</h2>
                  <p className="text-xs text-gray-500">Azure AD + Exchange + Teams + SharePoint</p>
                </div>
              </div>
              <StatusPill row={m365} loading={loading} />
            </header>

            {m365 && (m365.status === 'active' || m365.status === 'syncing') ? (
              <ConnectedBlock
                row={m365}
                onSync={() => runSync('m365')}
                onDisconnect={() => disconnect('m365')}
                busy={busy === 'sync' || m365.status === 'syncing'}
                disconnecting={busy === 'disconnect-m365'}
              />
            ) : (
              <div className="space-y-3">
                <button
                  onClick={startM365Consent}
                  disabled={busy === 'm365'}
                  className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-white text-sm font-medium transition-colors"
                >
                  {busy === 'm365' ? 'Connecting…' : 'Grant admin consent'}
                </button>
                <details className="text-xs">
                  <summary className="text-gray-500 cursor-pointer hover:text-gray-400">Or enter tenant ID manually</summary>
                  <div className="mt-3 space-y-2">
                    <input
                      placeholder="Tenant ID (Directory ID)"
                      value={m365Tenant} onChange={(e) => setM365Tenant(e.target.value)}
                      className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                    />
                    <input
                      placeholder="Primary domain (optional)"
                      value={m365Domain} onChange={(e) => setM365Domain(e.target.value)}
                      className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                    />
                    <button
                      onClick={connectM365Manual}
                      disabled={busy === 'm365'}
                      className="w-full px-3 py-2 bg-dark-700 hover:bg-dark-600 disabled:opacity-50 rounded-lg text-white text-xs"
                    >
                      Save & verify
                    </button>
                  </div>
                </details>
              </div>
            )}
          </section>

          {/* Google Workspace */}
          <section className="bg-dark-800 border border-dark-700 rounded-xl p-5">
            <header className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center">
                  <i className="ri-google-line text-xl" />
                </span>
                <div>
                  <h2 className="text-white font-semibold">Google Workspace</h2>
                  <p className="text-xs text-gray-500">Directory + Groups (service account + DWD)</p>
                </div>
              </div>
              <StatusPill row={google} loading={loading} />
            </header>

            {google && (google.status === 'active' || google.status === 'syncing') ? (
              <ConnectedBlock
                row={google}
                onSync={() => runSync('google')}
                onDisconnect={() => disconnect('google')}
                busy={busy === 'sync' || google.status === 'syncing'}
                disconnecting={busy === 'disconnect-google'}
              />
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-gray-400">
                  Sign in with your Google Workspace super-admin account. We'll request the directory + Gmail send permissions on the next screen — no manual setup needed.
                </p>
                <button
                  onClick={startGoogleConsent}
                  disabled={busy === 'google'}
                  className="w-full px-4 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg text-white text-sm font-medium transition-colors"
                >
                  {busy === 'google' ? 'Connecting…' : 'Sign in with Google'}
                </button>
              </div>
            )}
          </section>
        </div>

        {(m365?.status === 'active' || m365?.status === 'syncing' || google?.status === 'active' || google?.status === 'syncing') && (
          <div className="mt-5 flex justify-end">
            <button
              onClick={() => runSync('all')}
              disabled={busy === 'sync' || m365?.status === 'syncing' || google?.status === 'syncing'}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-white text-sm font-medium"
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync all now'}
            </button>
          </div>
        )}

        {/* Sender mailbox — only useful once M365 is connected. */}
        <SenderMailboxCard m365Connected={m365?.status === 'active' || m365?.status === 'syncing'} />
      </div>
    </DashboardLayout>
  );
}

function SenderMailboxCard({ m365Connected }: { m365Connected: boolean }) {
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [saved, setSaved] = useState<{ email: string; displayName: string }>({ email: '', displayName: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      const { data: m } = await supabase.from('org_members').select('org_id').eq('user_id', u.user?.id ?? '').limit(1).maybeSingle();
      const oid = (m as { org_id: string } | null)?.org_id ?? null;
      if (!oid) { setLoading(false); return; }
      setOrgId(oid);
      const { data: org } = await supabase
        .from('organizations')
        .select('em_sender_email, em_sender_display_name')
        .eq('id', oid)
        .maybeSingle();
      const row = org as { em_sender_email: string | null; em_sender_display_name: string | null } | null;
      const e = row?.em_sender_email ?? '';
      const d = row?.em_sender_display_name ?? '';
      setEmail(e); setDisplayName(d); setSaved({ email: e, displayName: d });
      setLoading(false);
    })();
  }, []);

  const dirty = email !== saved.email || displayName !== saved.displayName;

  const save = async () => {
    if (!orgId) return;
    setBusy(true); setMsg(null);
    const { error } = await supabase
      .from('organizations')
      .update({
        em_sender_email: email.trim() || null,
        em_sender_display_name: displayName.trim() || null,
      })
      .eq('id', orgId);
    setBusy(false);
    if (error) { setMsg({ kind: 'err', text: error.message }); return; }
    setSaved({ email: email.trim(), displayName: displayName.trim() });
    setMsg({ kind: 'ok', text: 'Sender mailbox saved. EM emails will now come from this address.' });
  };

  return (
    <section className="mt-6 bg-dark-800/40 border border-dark-700 rounded-xl p-5">
      <div className="flex items-center gap-3 mb-1">
        <span className="w-9 h-9 rounded-lg bg-cyan-500/15 text-cyan-400 flex items-center justify-center"><i className="ri-mail-send-line text-lg" /></span>
        <div>
          <h3 className="text-base font-semibold text-white">Employee Management — Sender Mailbox</h3>
          <p className="text-xs text-gray-500">Mailbox used for credential requests, decisions, and other employee emails.</p>
        </div>
      </div>

      {!m365Connected && (
        <div className="mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
          Connect Microsoft 365 above first — this mailbox must exist in your own tenant.
        </div>
      )}

      {loading ? (
        <p className="mt-3 text-xs text-gray-500">Loading…</p>
      ) : (
        <div className="mt-4 space-y-3 max-w-xl">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Sender email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="hr@yourcompany.com"
              className="w-full px-3 py-2 rounded-lg bg-dark-900 border border-dark-700 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500/50"
            />
            <p className="mt-1 text-[11px] text-gray-500">Must be a real mailbox in your Microsoft 365 tenant (not an alias or distribution list).</p>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Display name (optional)</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Acme HR"
              className="w-full px-3 py-2 rounded-lg bg-dark-900 border border-dark-700 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500/50"
            />
          </div>
          {msg && (
            <div className={`px-3 py-2 rounded-lg text-xs border ${
              msg.kind === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            }`}>{msg.text}</div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={busy || !dirty || !orgId}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium"
            >
              {busy ? 'Saving…' : 'Save mailbox'}
            </button>
            {saved.email && !dirty && (
              <span className="text-xs text-emerald-300">Sending from: <strong className="text-white">{saved.email}</strong></span>
            )}
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-gray-500 hover:text-cyan-400">Required Microsoft Graph permission</summary>
            <div className="mt-2 text-[11px] text-gray-400 leading-relaxed">
              For Rudrans to send mail FROM this mailbox, your Microsoft 365 admin must grant the application permission
              <strong className="text-white"> Mail.Send </strong>(scoped to this mailbox via RBAC if possible) and complete the admin consent flow again.
              Once granted, all credential request and offboarding emails will appear to come from{' '}
              <strong className="text-white">{saved.email || 'this mailbox'}</strong> instead of the default Rudrans address.
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

function StatusPill({ row, loading }: { row: OrgIntegration | undefined; loading: boolean }) {
  if (loading) return <span className="text-xs text-gray-500">Loading…</span>;
  if (!row) return <span className="text-xs px-2 py-1 rounded-full bg-dark-700 text-gray-400">Not connected</span>;
  const colour =
    row.status === 'active'  ? 'bg-emerald-500/15 text-emerald-400' :
    row.status === 'syncing' ? 'bg-blue-500/15 text-blue-400 animate-pulse' :
    row.status === 'error'   ? 'bg-rose-500/15 text-rose-400' :
                               'bg-amber-500/15 text-amber-400';
  return <span className={`text-xs px-2 py-1 rounded-full ${colour}`}>
    {row.status === 'syncing' ? 'syncing…' : row.status}
  </span>;
}

function ConnectedBlock({
  row, onSync, onDisconnect, busy, disconnecting,
}: {
  row: OrgIntegration;
  onSync: () => void;
  onDisconnect: () => void;
  busy: boolean;
  disconnecting: boolean;
}) {
  return (
    <div className="space-y-3">
      <dl className="text-xs grid grid-cols-2 sm:grid-cols-3 gap-y-1.5 gap-x-3">
        <dt className="text-gray-500">Tenant</dt>
        <dd className="col-span-2 text-gray-300 truncate">{row.tenant_id ?? '—'}</dd>
        <dt className="text-gray-500">Domain</dt>
        <dd className="col-span-2 text-gray-300 truncate">{row.primary_domain ?? '—'}</dd>
        {row.impersonate_subject && (<>
          <dt className="text-gray-500">Acting as</dt>
          <dd className="col-span-2 text-gray-300 truncate">{row.impersonate_subject}</dd>
        </>)}
        <dt className="text-gray-500">By</dt>
        <dd className="col-span-2 text-gray-300 truncate">{row.connected_by_email ?? '—'}</dd>
        <dt className="text-gray-500">Last sync</dt>
        <dd className="col-span-2 text-gray-300 truncate">{row.last_sync_at ? new Date(row.last_sync_at).toLocaleString() : 'never'}</dd>
        {row.last_sync_error && (<>
          <dt className="text-gray-500">Error</dt>
          <dd className="col-span-2 text-rose-400 break-words">{row.last_sync_error}</dd>
        </>)}
      </dl>
      <div className="flex gap-2">
        <button
          onClick={onSync}
          disabled={busy || disconnecting}
          className="flex-1 px-3 py-2 bg-dark-700 hover:bg-dark-600 disabled:opacity-50 rounded-lg text-white text-xs font-medium"
        >
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        {/* Disconnect stays clickable even while syncing — it's the escape hatch when sync is stuck. */}
        <button
          onClick={onDisconnect}
          disabled={disconnecting}
          className="px-3 py-2 bg-rose-500/15 hover:bg-rose-500/25 disabled:opacity-50 rounded-lg text-rose-300 text-xs font-medium border border-rose-500/30"
        >
          {disconnecting ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
    </div>
  );
}

// ============== setup info card ==============
// Shows the SA Client ID + scopes the customer's admin needs to configure
// in Google Admin (or in Entra for M365) BEFORE the Connect attempt. These
// values are public — Google/Microsoft display them on consent screens to
// the customer anyway — so we just fetch them via the `directory_setup_info`
// RPC and render them with copy buttons. Replaces the earlier "scopes visible
// after submit" UX, which made the first connect attempt always fail.

function SetupInfo({ provider }: { provider: 'm365' | 'google' }) {
  type Info = {
    google_sa_client_id: string | null;
    google_sa_client_email: string | null;
    google_scopes: string[];
    m365_client_id: string | null;
    m365_scopes: string[];
  };
  const [info, setInfo] = useState<Info | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc('directory_setup_info');
      const row = Array.isArray(data) ? data[0] : data;
      if (row) setInfo(row as Info);
    })();
  }, []);

  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); setTimeout(() => setCopied(null), 1500); } catch { /* ignore */ }
  };

  if (!info) {
    return <p className="text-xs text-gray-500">Loading setup info…</p>;
  }

  if (provider === 'google') {
    const saId = info.google_sa_client_id ?? '';
    const saEmail = info.google_sa_client_email ?? '';
    const setupReady = !!saId;
    return (
      <div className="rounded-lg border border-dark-700 bg-dark-900/40 p-3 text-xs space-y-2.5 mb-2">
        <p className="text-gray-400 leading-relaxed">
          <strong className="text-white">Before submitting</strong>, your Google Workspace super-admin must enable Domain-wide delegation for our service account:
        </p>
        <ol className="ml-4 list-decimal text-gray-400 space-y-1">
          <li>Open <a href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noreferrer" className="text-amber-400 hover:underline">Google Admin → Security → API controls → Domain-wide delegation</a></li>
          <li>Add a new API client with the <strong className="text-white">Client ID</strong> below and the <strong className="text-white">OAuth scopes</strong> below</li>
          <li>Then paste your Workspace super-admin email here and click Connect</li>
        </ol>
        {!setupReady ? (
          <div className="px-2.5 py-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300">
            ⚠ Google service-account Client ID not configured by Rudrans yet. Contact support — we need to set <code className="px-1 bg-rose-500/15 rounded">GOOGLE_SA_CLIENT_ID</code> in /admin/integrations.
          </div>
        ) : (
          <>
            <CopyRow label="Service account Client ID" value={saId} copied={copied === 'gcid'} onCopy={() => copy('gcid', saId)} />
            {saEmail && (
              <CopyRow label="Service account email" value={saEmail} copied={copied === 'gce'} onCopy={() => copy('gce', saEmail)} />
            )}
            <CopyRow label="OAuth scopes (comma-separated)" value={info.google_scopes.join(',')} copied={copied === 'gscope'} onCopy={() => copy('gscope', info.google_scopes.join(','))} multiline />
          </>
        )}
      </div>
    );
  }

  // M365
  const clientId = info.m365_client_id ?? '';
  return (
    <div className="rounded-lg border border-dark-700 bg-dark-900/40 p-3 text-xs space-y-2.5 mb-2">
      <p className="text-gray-400 leading-relaxed">
        Clicking <strong className="text-white">Grant admin consent</strong> below redirects your global admin to Microsoft to approve these application permissions:
      </p>
      <CopyRow label="Application (client) ID" value={clientId} copied={copied === 'mid'} onCopy={() => copy('mid', clientId)} />
      <CopyRow label="Required Graph permissions" value={info.m365_scopes.join(', ')} copied={copied === 'mscope'} onCopy={() => copy('mscope', info.m365_scopes.join(', '))} multiline />
      <p className="text-[11px] text-gray-500">
        If consent fails with "permission not granted", your Entra admin must accept the new permission set (we added <code className="px-1 bg-dark-700 rounded">Mail.Send</code> recently for sending emails from your mailbox).
      </p>
    </div>
  );
}

function CopyRow({ label, value, copied, onCopy, multiline }: { label: string; value: string; copied: boolean; onCopy: () => void; multiline?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</p>
      <div className={`flex items-${multiline ? 'start' : 'center'} gap-2`}>
        <code className={`flex-1 px-2 py-1.5 rounded bg-dark-900 border border-dark-700 text-gray-300 break-all ${multiline ? 'whitespace-pre-wrap' : 'truncate'}`}>{value || '—'}</code>
        <button
          onClick={onCopy}
          className={`px-2 py-1 rounded text-[10px] font-medium border shrink-0 transition-colors ${
            copied
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              : 'bg-dark-700 hover:bg-dark-600 text-gray-300 border-dark-600'
          }`}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
