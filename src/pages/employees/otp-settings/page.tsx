// OTP Channels — org-wide settings page.
//
// One card per channel. Each shows a "Connected / Not connected" badge
// (sourced from org_otp_settings_safe — never sees raw secrets) and a
// form to enter the missing config. Tokens are write-only: the input
// renders blank when a token already exists, and submitting a blank
// value LEAVES the existing token intact. Submitting an empty string
// (via the small "Disconnect" button) clears it.
//
// Admin-link section at the bottom lets the current user register their
// Slack member id / Teams AAD oid / WA number / Google Chat user id so
// inbound replies are attributed to their auth.users.id.

import { useEffect, useMemo, useState } from 'react';
import DashboardLayout from '../../dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';

interface Safe {
  org_id: string;
  teams_connected: boolean;
  teams_webhook_set: boolean;
  teams_delegated_set: boolean;
  teams_admin_email: string | null;
  teams_tenant_id: string | null;
  teams_team_id: string | null;
  teams_channel_id: string | null;
  teams_enabled: boolean;
  google_chat_connected: boolean;
  google_chat_space_name: string | null;
  google_chat_enabled: boolean;
  slack_connected: boolean;
  slack_channel_id: string | null;
  slack_enabled: boolean;
  whatsapp_connected: boolean;
  whatsapp_provider: 'meta_cloud' | 'twilio' | null;
  whatsapp_phone_id: string | null;
  whatsapp_admin_numbers: string[];
  whatsapp_template_name: string | null;
  whatsapp_enabled: boolean;
  magic_link_base_url: string | null;
  updated_at: string | null;
}

type ChannelKey = 'slack' | 'teams' | 'google_chat' | 'whatsapp';

export default function OtpSettingsPage() {
  const [s, setS] = useState<Safe | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from('org_otp_settings_safe').select('*').maybeSingle();
    setS((data as Safe) ?? null);
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const save = async (cardId: string, payload: Record<string, unknown>) => {
    setSaving(cardId);
    setErr(null);
    setOk(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/org-otp-settings-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setOk(`Saved ${cardId}`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-4xl">
        <header className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl text-white font-semibold">OTP Channels</h1>
            <p className="text-sm text-gray-400 mt-1">
              When the auto-invoice fetcher hits an OTP screen, it pings these channels until one admin sends the code.
              Set up as many as you like — the fetcher picks the credential's primary channel and falls back through the others.
            </p>
          </div>
        </header>

        {(err || ok) && (
          <div className={`px-4 py-2 rounded-lg text-xs ${err ? 'bg-rose-500/10 border border-rose-500/30 text-rose-300' : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'}`}>
            {err ?? ok}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <>
            <UniversalCard s={s} />
            <SlackCard    s={s} saving={saving === 'slack'} onSave={(p) => save('slack', p)} onMutated={load} />
            <TeamsCard    s={s} saving={saving === 'teams'} onSave={(p) => save('teams', p)} onMutated={load} />
            <GChatCard    s={s} saving={saving === 'gchat'} onSave={(p) => save('gchat', p)} onMutated={load} />
            <WhatsappCard s={s} saving={saving === 'whatsapp'} onSave={(p) => save('whatsapp', p)} onMutated={load} />
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────

function Card({
  title, connected, enabled, hint, channelKey, onSave, onMutated, children,
}: {
  title: string;
  connected: boolean;
  // `true`/`false` when the channel is connected; `undefined` when the
  // toggle should be hidden (still disconnected — no behaviour to toggle).
  enabled?: boolean;
  hint: string;
  channelKey?: ChannelKey;
  onSave?: (p: Record<string, unknown>) => void;
  onMutated?: () => Promise<void> | void;
  children: React.ReactNode;
}) {
  const status = !connected
    ? { label: 'Not connected', cls: 'bg-gray-500/15 text-gray-400' }
    : enabled === false
      ? { label: 'Disabled',    cls: 'bg-amber-500/15 text-amber-300' }
      : { label: 'Connected',   cls: 'bg-emerald-500/15 text-emerald-300' };
  return (
    <section className="bg-dark-800 border border-dark-700 rounded-xl p-5">
      <div className="flex items-start justify-between mb-2 gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-white font-medium">{title}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{hint}</p>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${status.cls}`}>
          {status.label}
        </span>
      </div>
      <div className="mt-3 space-y-3">{children}</div>
      {/* Connection controls (Enable / Disconnect) — only when actually connected. */}
      {connected && channelKey && onSave && onMutated && (
        <ConnectionControls
          channelKey={channelKey}
          enabled={enabled ?? true}
          onSave={onSave}
          onMutated={onMutated}
        />
      )}
    </section>
  );
}

// Toggle + Disconnect row at the bottom of each channel card. Lives here
// (not inside each <ChannelCard>) so the wiring stays in one place and the
// behaviour is identical across Slack / Teams / Google Chat / WhatsApp.
function ConnectionControls({
  channelKey, enabled, onSave, onMutated,
}: {
  channelKey: ChannelKey;
  enabled: boolean;
  onSave: (p: Record<string, unknown>) => void;
  onMutated: () => Promise<void> | void;
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const toggle = () => {
    onSave({ [`${channelKey}_enabled`]: !enabled });
  };
  const disconnect = async () => {
    if (!confirm(
      `Disconnect ${channelLabel(channelKey)}? This wipes the stored token + IDs. ` +
      `If you just want to pause delivery without losing the credentials, use the toggle instead.`,
    )) return;
    setDisconnecting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/otp-channel-disconnect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channelKey }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await onMutated();
    } catch (e) {
      alert(`Disconnect failed: ${(e as Error).message}`);
    } finally { setDisconnecting(false); }
  };
  return (
    <div className="mt-4 pt-3 border-t border-dark-700 flex items-center justify-between gap-3 flex-wrap">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <span className="text-[11px] text-gray-400">
          {enabled ? 'Active — will send OTPs' : 'Disabled — credentials kept, fan-out skips this channel'}
        </span>
        <span className={`relative inline-block w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-emerald-500' : 'bg-dark-600'}`}>
          <input type="checkbox" checked={enabled} onChange={toggle} className="sr-only" />
          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </span>
      </label>
      <button
        onClick={disconnect}
        disabled={disconnecting}
        className="text-[11px] px-2.5 py-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 disabled:opacity-50"
        title="Wipe stored credentials for this channel"
      >
        <i className="ri-link-unlink-m mr-1" />
        {disconnecting ? 'Disconnecting…' : 'Disconnect'}
      </button>
    </div>
  );
}

function channelLabel(k: ChannelKey): string {
  return ({ slack: 'Slack', teams: 'Microsoft Teams', google_chat: 'Google Chat', whatsapp: 'WhatsApp' } as const)[k];
}

function Row({ label, children, help }: { label: string; children: React.ReactNode; help?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-gray-500 mb-1 block">{label}</span>
      {children}
      {help && <span className="text-[11px] text-gray-600 mt-1 block">{help}</span>}
    </label>
  );
}

const inputCls = 'w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-emerald-500 outline-none';

function UniversalCard({ s }: { s: Safe | null }) {
  return (
    <Card
      title="Always-on fallbacks"
      connected
      hint="Magic-link email + in-dashboard banner work without any setup. Configure their behaviour below."
    >
      <p className="text-xs text-gray-400">
        Magic link base URL:{' '}
        <span className="text-emerald-300 font-mono">{s?.magic_link_base_url ?? 'https://ems.wellnessextract.com'}</span>
      </p>
      <p className="text-[11px] text-gray-500">
        Override only if you proxy Wellness Extract behind a custom domain. Per-credential OTP admins still get an email here even if external channels fail.
      </p>
    </Card>
  );
}

function SlackCard({ s, saving, onSave, onMutated }: { s: Safe | null; saving: boolean; onSave: (p: Record<string, unknown>) => void; onMutated: () => Promise<void> | void }) {
  const [botToken, setBotToken] = useState('');
  const [channel, setChannel] = useState(s?.slack_channel_id ?? '');
  const [signing, setSigning] = useState('');
  const [memberId, setMemberId] = useState('');
  return (
    <Card
      title="Slack"
      connected={!!s?.slack_connected}
      enabled={s?.slack_enabled}
      channelKey="slack"
      onSave={onSave}
      onMutated={onMutated}
      hint="Bot posts to a channel; admins reply with the 6-digit code in-thread."
    >
      <Row label="Bot token (xoxb-…)" help={s?.slack_connected ? 'Leave blank to keep existing token.' : 'Slack App → OAuth & Permissions → Bot User OAuth Token. Needs chat:write.'}>
        <input value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="xoxb-…" className={inputCls} />
      </Row>
      <Row label="Channel id" help="e.g. C0123456789 — open the channel, ⋯ menu, Copy link, last segment.">
        <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C0123…" className={inputCls} />
      </Row>
      <Row label="Signing secret" help="Slack App → Basic Information → Signing Secret. Used to verify inbound webhooks.">
        <input value={signing} onChange={(e) => setSigning(e.target.value)} placeholder={s?.slack_connected ? '••••••••' : 'abc123…'} className={inputCls} />
      </Row>
      <Row label="My Slack member id (optional)" help="Used to attribute YOUR replies to your Wellness Extract account. Find via Profile → ⋯ → Copy member ID.">
        <input value={memberId} onChange={(e) => setMemberId(e.target.value)} placeholder="U12345…" className={inputCls} />
      </Row>
      <div className="flex items-center gap-3 pt-1">
        <button
          disabled={saving}
          onClick={() => onSave({
            slack_bot_token: botToken || undefined,
            slack_channel_id: channel || null,
            slack_signing_secret: signing || undefined,
            admin_links: memberId ? [{ provider: 'slack', external_id: memberId }] : undefined,
          })}
          className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-semibold disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save Slack'}
        </button>
        <p className="text-[11px] text-gray-500">
          Inbound webhook URL: <span className="font-mono">{import.meta.env.VITE_SUPABASE_URL}/functions/v1/otp-inbound-slack?org=&lt;your-org-id&gt;</span>
        </p>
      </div>
    </Card>
  );
}

function TeamsCard({ s, saving, onSave, onMutated }: { s: Safe | null; saving: boolean; onSave: (p: Record<string, unknown>) => void; onMutated: () => Promise<void> | void }) {
  const connected = !!s?.teams_delegated_set;
  const [busy, setBusy] = useState(false);
  const [teamId, setTeamId] = useState(s?.teams_team_id ?? '');
  const [channelId, setChannelId] = useState(s?.teams_channel_id ?? '');
  const [teamsList, setTeamsList] = useState<Array<{ id: string; displayName: string; channels: Array<{ id: string; displayName: string }> }>>([]);
  const [listError, setListError] = useState<string | null>(null);

  // Show success banner if redirected back from OAuth.
  const url = new URLSearchParams(window.location.search);
  const justConnected = url.get('teams') === 'connected';
  const oauthErr = url.get('teams') === 'error' ? url.get('msg') : null;

  const startOAuth = async () => {
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/teams-oauth-start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok || !j.authorize_url) throw new Error(j.error ?? `${r.status}`);
      window.location.href = j.authorize_url;
    } catch (e) {
      alert(`Could not start sign-in: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  const loadTeams = async () => {
    setListError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/teams-channels-list`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setTeamsList(j.teams ?? []);
    } catch (e) {
      setListError((e as Error).message);
    }
  };

  useEffect(() => {
    if (connected && teamsList.length === 0) void loadTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  return (
    <Card
      title="Microsoft Teams"
      connected={connected && !!s?.teams_team_id && !!s?.teams_channel_id}
      enabled={s?.teams_enabled}
      channelKey="teams"
      onSave={onSave}
      onMutated={onMutated}
      hint="An admin from your tenant signs in once with Microsoft; OTP messages then post as that admin into the team/channel you pick below."
    >
      {oauthErr && (
        <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-3 text-[11px] text-rose-300">
          Sign-in failed: {oauthErr}
        </div>
      )}
      {justConnected && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 text-[11px] text-emerald-300">
          Microsoft account connected{s?.teams_admin_email ? ` as ${s.teams_admin_email}` : ''}. Now pick the team + channel below.
        </div>
      )}

      {!connected ? (
        <>
          <div className="rounded-lg bg-dark-900/40 border border-dark-700 p-3 text-[11px] text-gray-400 leading-relaxed">
            <p className="text-white text-xs font-medium mb-1.5">Why Sign-in (not a webhook)?</p>
            <p>Microsoft retired Incoming Webhooks (Dec 2025) and locks Graph app-only posting behind <em>Teamwork.Migrate.All</em>. The only path that works in every tenant is delegated OAuth: one admin signs in once, their refresh token mints fresh access tokens for posting on their behalf.</p>
            <p className="mt-2 text-amber-300/80">Required: the admin who signs in must be a member of the team/channel where OTPs should appear.</p>
          </div>
          <button
            onClick={startOAuth}
            disabled={busy}
            className="w-full mt-2 px-4 py-2.5 rounded-lg bg-[#2F2F2F] hover:bg-[#1B1B1B] border border-dark-600 text-white text-sm font-medium flex items-center justify-center gap-3 disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg">
              <rect x="1"  y="1"  width="10" height="10" fill="#F25022"/>
              <rect x="12" y="1"  width="10" height="10" fill="#7FBA00"/>
              <rect x="1"  y="12" width="10" height="10" fill="#00A4EF"/>
              <rect x="12" y="12" width="10" height="10" fill="#FFB900"/>
            </svg>
            {busy ? 'Opening Microsoft…' : 'Sign in with Microsoft'}
          </button>
        </>
      ) : (
        <>
          <div className="rounded-lg bg-dark-900/40 border border-dark-700 p-3 text-[11px] text-gray-300 leading-relaxed flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Signed in as <span className="text-white font-medium">{s?.teams_admin_email ?? '(unknown)'}</span>
            <button onClick={startOAuth} className="ml-auto text-cyan-400 hover:text-cyan-300">Switch account →</button>
          </div>

          <Row label="Team" help="Only teams the signed-in admin is a member of are listed.">
            <select
              value={teamId}
              onChange={(e) => { setTeamId(e.target.value); setChannelId(''); }}
              className={inputCls}
            >
              <option value="">— Pick a team —</option>
              {teamsList.map((t) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
            </select>
          </Row>

          <Row label="Channel">
            <select
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              className={inputCls}
              disabled={!teamId}
            >
              <option value="">{teamId ? '— Pick a channel —' : '(pick a team first)'}</option>
              {(teamsList.find((t) => t.id === teamId)?.channels ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
          </Row>

          {listError && <p className="text-[11px] text-rose-300">List failed: {listError}</p>}

          <div className="flex items-center gap-3 pt-1">
            <button
              disabled={saving || !teamId || !channelId}
              onClick={() => onSave({ teams_team_id: teamId || null, teams_channel_id: channelId || null })}
              className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-semibold disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save channel'}
            </button>
            <button onClick={loadTeams} className="text-[11px] text-cyan-400 hover:text-cyan-300">Refresh list</button>
            <p className="text-[11px] text-gray-500 ml-auto">Then "Test ping" on Auto-Invoice page.</p>
          </div>
        </>
      )}
    </Card>
  );
}

function GChatCard({ s, saving, onSave, onMutated }: { s: Safe | null; saving: boolean; onSave: (p: Record<string, unknown>) => void; onMutated: () => Promise<void> | void }) {
  const [webhook, setWebhook] = useState('');
  const [space, setSpace] = useState(s?.google_chat_space_name ?? '');
  return (
    <Card
      title="Google Chat"
      connected={!!s?.google_chat_connected}
      enabled={s?.google_chat_enabled}
      channelKey="google_chat"
      onSave={onSave}
      onMutated={onMutated}
      hint="Wellness Extract posts OTP cards to your space, and admins reply with the code directly inside Google Chat — no magic-link round-trip."
    >
      <Row
        label="Outbound: webhook URL"
        help={s?.google_chat_connected ? 'Leave blank to keep existing URL.' : 'Space → ⋯ menu → Apps & integrations → Manage webhooks → Add webhook.'}
      >
        <input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://chat.googleapis.com/v1/spaces/…" className={inputCls} />
      </Row>
      <Row
        label="Space ID (required for inbound replies)"
        help={
          <>
            Open the space → click the space name at the top → scroll down → copy <code className="text-cyan-300">spaces/AAAAxxxxx</code>.
            {' '}Add the Wellness Extract Chat App to this space so admins can reply to OTPs inline. See the {' '}
            <a href="/docs/integrations#gchat" target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">Integrations Guide</a> for the one-time setup.
          </>
        }
      >
        <input value={space} onChange={(e) => setSpace(e.target.value)} placeholder="spaces/AAAA…" className={inputCls} />
      </Row>
      <div className="flex items-center gap-3 pt-1">
        <button
          disabled={saving}
          onClick={() => onSave({
            google_chat_webhook_url: webhook || undefined,
            google_chat_space_name: space || null,
          })}
          className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-semibold disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save Google Chat'}
        </button>
        <p className="text-[11px] text-gray-500">
          Bidirectional: webhook = outbound · Chat App + Space ID = inbound replies.
        </p>
      </div>
    </Card>
  );
}

function WhatsappCard({ s, saving, onSave, onMutated }: { s: Safe | null; saving: boolean; onSave: (p: Record<string, unknown>) => void; onMutated: () => Promise<void> | void }) {
  const [token, setToken] = useState('');
  const [phoneId, setPhoneId] = useState(s?.whatsapp_phone_id ?? '');
  const [numbers, setNumbers] = useState((s?.whatsapp_admin_numbers ?? []).join(', '));
  const [template, setTemplate] = useState(s?.whatsapp_template_name ?? '');
  const [myNumber, setMyNumber] = useState('');

  const parsedNumbers = useMemo(
    () => numbers.split(',').map((x) => x.trim()).filter(Boolean),
    [numbers],
  );

  return (
    <Card
      title="WhatsApp"
      connected={!!s?.whatsapp_connected}
      enabled={s?.whatsapp_enabled}
      channelKey="whatsapp"
      onSave={onSave}
      onMutated={onMutated}
      hint="Meta Cloud API sends a template message to listed admin numbers. They reply with the code."
    >
      <Row label="Provider">
        <select disabled value="meta_cloud" className={inputCls}>
          <option value="meta_cloud">Meta Cloud API</option>
        </select>
      </Row>
      <Row label="Phone number id" help="From Meta Business Manager → WhatsApp → API setup → Phone number ID.">
        <input value={phoneId} onChange={(e) => setPhoneId(e.target.value)} placeholder="1234567890" className={inputCls} />
      </Row>
      <Row label="Access token" help={s?.whatsapp_connected ? 'Leave blank to keep existing token.' : 'System-user permanent token, not the temporary 24h one.'}>
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAG…" className={inputCls} />
      </Row>
      <Row label="Approved template name" help="Meta Business → Message Templates. Must have 4 body params: platform, prompt, link, expiry-min.">
        <input value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="we_otp_prompt" className={inputCls} />
      </Row>
      <Row label="Admin numbers (E.164, comma-separated)" help="+919876543210, +919812345678">
        <input value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder="+91…, +91…" className={inputCls} />
      </Row>
      <Row label="My WhatsApp number (optional)" help="Used to attribute YOUR replies to your Wellness Extract account.">
        <input value={myNumber} onChange={(e) => setMyNumber(e.target.value)} placeholder="+919876543210" className={inputCls} />
      </Row>
      <div className="flex items-center gap-3 pt-1">
        <button
          disabled={saving}
          onClick={() => onSave({
            whatsapp_provider: 'meta_cloud',
            whatsapp_phone_id: phoneId || null,
            whatsapp_token: token || undefined,
            whatsapp_template_name: template || null,
            whatsapp_admin_numbers: parsedNumbers,
            admin_links: myNumber ? [{ provider: 'whatsapp', external_id: myNumber.replace(/^\+/, '') }] : undefined,
          })}
          className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-semibold disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save WhatsApp'}
        </button>
        <p className="text-[11px] text-gray-500">{parsedNumbers.length} admin number{parsedNumbers.length === 1 ? '' : 's'}</p>
      </div>
    </Card>
  );
}
