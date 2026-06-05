// Auto-Invoice command center. Single page where the customer can see
// everything: this-month KPI, channel health, today's activity feed
// (realtime), 6-month coverage matrix, and shortcuts to every connection
// wizard. Replaces the need to bounce between the vault Fetch-status tab,
// OTP settings, and email inboxes.
//
// Realtime: subscribes to `invoice_fetch_events` filtered to the current
// org so the feed prepends new rows as they happen.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '../../dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

// ── Types ────────────────────────────────────────────────────────────────

interface FetchEvent {
  id: string;
  credential_id: string | null;
  job_id: string | null;
  invoice_id: string | null;
  kind: string;
  actor: string | null;
  channel: string | null;
  message: string | null;
  created_at: string;
}

interface CoverageRow {
  credential_id: string;
  platform_name: string;
  month_start: string;
  month_end: string;
  state: 'covered' | 'pending' | 'missing' | 'na';
  invoice_count: number;
}

interface InvoiceRow {
  amount: number | null;
  currency: string | null;
  source: string;
  issue_date: string | null;
}

interface ChannelStatus {
  teams_connected: boolean;
  slack_connected: boolean;
  google_chat_connected: boolean;
  whatsapp_connected: boolean;
}

interface OrgInfo {
  id: string;
  invoice_inbound_slug: string;                 // 8-char unique slug (migration 0096)
  accounts_recipient_emails: string[];
  invoice_digest_enabled: boolean;
  invoice_digest_time: string;                  // "HH:MM:SS"
  invoice_digest_timezone: string;
  invoice_digest_recipient_emails: string[];
  invoice_digest_last_sent_at: string | null;
}

interface CronRun {
  id: string;
  name: string;
  started_at: string;
  completed_at: string | null;
  ok: boolean | null;
  enqueued: number | null;
  error: string | null;
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function AutoInvoicePage() {
  const { organization } = useAuth();
  const orgId = organization?.id ?? null;

  const [events, setEvents] = useState<FetchEvent[]>([]);
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [monthInvoices, setMonthInvoices] = useState<InvoiceRow[]>([]);
  const [channels, setChannels] = useState<ChannelStatus | null>(null);
  const [crons, setCrons] = useState<CronRun[]>([]);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const loadAll = async () => {
    setLoading(true);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthIso = monthStart.toISOString();

    const [ev, cov, inv, ch, cr, og] = await Promise.all([
      supabase
        .from('invoice_fetch_events')
        .select('id, credential_id, job_id, invoice_id, kind, actor, channel, message, created_at')
        .order('created_at', { ascending: false })
        .limit(80),
      supabase.from('v_credential_coverage').select('credential_id, platform_name, month_start, month_end, state, invoice_count'),
      supabase
        .from('credential_invoices')
        .select('amount, currency, source, issue_date')
        .gte('issue_date', monthIso.slice(0, 10)),
      supabase.from('org_otp_settings_safe').select('teams_connected, slack_connected, google_chat_connected, whatsapp_connected').maybeSingle(),
      supabase.from('cron_runs').select('id, name, started_at, completed_at, ok, enqueued, error').order('started_at', { ascending: false }).limit(8),
      // Pin the org lookup to the user's ACTUAL org from AuthContext.
      // Without `.eq('id', orgId)`, super-admins (who have an RLS pass on
      // every org) get back an arbitrary row from `.limit(1)` — which
      // makes the page display some other tenant's inbound address while
      // org-settings-save targets the user's real org, so saves "vanish".
      orgId
        ? supabase.from('organizations')
            .select('id, invoice_inbound_slug, accounts_recipient_emails, invoice_digest_enabled, invoice_digest_time, invoice_digest_timezone, invoice_digest_recipient_emails, invoice_digest_last_sent_at')
            .eq('id', orgId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    setEvents((ev.data ?? []) as FetchEvent[]);
    setCoverage((cov.data ?? []) as CoverageRow[]);
    setMonthInvoices((inv.data ?? []) as InvoiceRow[]);
    setChannels(ch.data as ChannelStatus | null);
    setCrons((cr.data ?? []) as CronRun[]);
    setOrg(og.data as OrgInfo | null);
    setLoading(false);
  };

  // Re-run loadAll once orgId resolves from AuthContext (it's async on
  // first paint). Without the dep, the initial render runs with orgId=null
  // and the org panel stays empty until a manual refresh.
  useEffect(() => { void loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [orgId]);

  // Realtime feed.
  useEffect(() => {
    if (!orgId) return;
    const ch = supabase
      .channel(`autoinv:${orgId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'invoice_fetch_events', filter: `org_id=eq.${orgId}` },
        (payload) => {
          const row = payload.new as FetchEvent;
          setEvents((prev) => [row, ...prev].slice(0, 80));
        },
      )
      .subscribe();
    channelRef.current = ch;
    return () => { if (channelRef.current) supabase.removeChannel(channelRef.current); };
  }, [orgId]);

  // KPIs derived from this-month invoices.
  const kpis = useMemo(() => {
    const byTier = { api: 0, email: 0, scrape: 0, manual: 0, csv: 0 };
    let total = 0;
    let amount = 0;
    for (const i of monthInvoices) {
      total += 1;
      if (i.source?.startsWith('api_')) byTier.api += 1;
      else if (i.source === 'email')  byTier.email += 1;
      else if (i.source === 'scrape') byTier.scrape += 1;
      else if (i.source === 'csv')    byTier.csv += 1;
      else                            byTier.manual += 1;
      if (i.amount != null) amount += Number(i.amount);
    }
    const autoCount = byTier.api + byTier.email + byTier.scrape;
    const successRate = total > 0 ? Math.round((autoCount / total) * 100) : 0;
    return { total, byTier, amount, successRate, autoCount };
  }, [monthInvoices]);

  return (
    <DashboardLayout>
      <div className="space-y-5 max-w-7xl">
        <header className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl text-white font-semibold">Auto-Invoice Center</h1>
            <p className="text-sm text-gray-400 mt-1">
              Tracks every invoice the fetcher pulls — via API, email, or browser-agent — and forwards them to your accounts team.
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/employees/credentials" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white">
              <i className="ri-key-2-line mr-1" /> Credentials Vault
            </Link>
            <Link to="/employees/otp-settings" className="px-3 py-2 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white">
              <i className="ri-settings-3-line mr-1" /> OTP channels
            </Link>
          </div>
        </header>

        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <>
            <KpiRow kpis={kpis} />
            <DeliveryCard org={org} onChanged={loadAll} />
            <DigestCard org={org} onChanged={loadAll} />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <ActivityFeed events={events} className="lg:col-span-2" />
              <ConnectionsCard channels={channels} crons={crons} onTested={loadAll} />
            </div>
            <CoverageMatrix coverage={coverage} />
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

// ── Delivery card (inbound address + accounts recipients) ───────────────
// The two pieces of per-org config the customer is most likely to touch.
//   • Inbound email address — paste-into-platform-billing-settings (read-only).
//   • Accounts recipients — comma-separated emails the org's accounts team
//     uses; every fetched invoice gets forwarded there.

function DeliveryCard({ org, onChanged }: { org: OrgInfo | null; onChanged: () => void }) {
  // Prefer the short slug; fall back to the legacy full-uuid form so the
  // address still resolves while a brand-new org is missing its slug
  // (shouldn't happen post-migration 0096 but the trigger could theoretically
  // race a fast follow-up insert).
  const inboundAddr = org
    ? `inv-${org.invoice_inbound_slug || org.id}@invoices.wellnessextract.com`
    : '';
  const initial = (org?.accounts_recipient_emails ?? []).join(', ');
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [copyFlash, setCopyFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setDraft(initial); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [org?.id]);

  const parsed = useMemo(
    () => draft.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.includes('@')),
    [draft],
  );
  const dirty = draft !== initial;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/org-settings-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts_recipient_emails: parsed }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 3000);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inboundAddr);
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <section className="bg-dark-800 border border-dark-700 rounded-xl p-5">
      <div className="flex items-start justify-between flex-wrap gap-2 mb-4">
        <div>
          <h2 className="text-white font-medium text-sm">Delivery setup</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">Inbound address goes on each platform's billing email field. Forwarded invoices land in the accounts team's inbox.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Inbound address — read-only, copy-to-clipboard */}
        <div className="rounded-lg bg-dark-900/50 border border-dark-700 p-3">
          <p className="text-[11px] uppercase tracking-wider text-gray-500 mb-1.5">Your inbound invoice address</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-emerald-300 font-mono bg-dark-900 px-2 py-1.5 rounded border border-dark-700 truncate">
              {inboundAddr || '— loading —'}
            </code>
            <button
              onClick={copy}
              disabled={!inboundAddr}
              className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 text-[11px] disabled:opacity-40"
            >
              {copyFlash ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
            Paste this in <strong>each SaaS platform's billing email setting</strong> (Adobe → Account → Billing email, Microsoft → Admin → Billing notifications, etc.). The platform will email invoices here; we capture and forward them.
          </p>
        </div>

        {/* Accounts recipients — editable, per-org */}
        <div className="rounded-lg bg-dark-900/50 border border-dark-700 p-3">
          <p className="text-[11px] uppercase tracking-wider text-gray-500 mb-1.5">Forward invoices to (accounts team)</p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="accounts@your-company.com, finance@your-company.com"
            rows={2}
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:border-emerald-500 outline-none font-mono resize-none"
          />
          <div className="flex items-center justify-between mt-2">
            <p className="text-[11px] text-gray-500">
              {parsed.length > 0 ? `${parsed.length} recipient${parsed.length === 1 ? '' : 's'}` : 'comma-separated'}
            </p>
            <div className="flex items-center gap-2">
              {savedFlash && <span className="text-[11px] text-emerald-400">✓ Saved</span>}
              {error && <span className="text-[11px] text-rose-400">{error}</span>}
              <button
                onClick={save}
                disabled={!dirty || saving || parsed.length === 0}
                className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-[11px] font-semibold disabled:opacity-40"
              >
                {saving ? '…' : 'Save'}
              </button>
            </div>
          </div>
          {parsed.length === 0 && draft.trim() !== '' && (
            <p className="text-[11px] text-amber-300/80 mt-1">No valid email in input — needs an "@"</p>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Daily-digest schedule card ──────────────────────────────────────────
// Admin sets a local time + recipients. Pg_cron's invoice_digest_tick
// (every 15 min) fires the edge fn, which finds orgs whose local time
// matches and sends a single digest email listing the day's invoices.

const TIMEZONES = [
  'Asia/Kolkata', 'Asia/Singapore', 'Asia/Dubai',
  'Europe/London', 'Europe/Berlin',
  'America/New_York', 'America/Los_Angeles',
  'UTC',
];

function DigestCard({ org, onChanged }: { org: OrgInfo | null; onChanged: () => void }) {
  const initialEnabled = !!org?.invoice_digest_enabled;
  const initialTime = (org?.invoice_digest_time ?? '09:00:00').slice(0, 5);
  const initialTz = org?.invoice_digest_timezone ?? 'Asia/Kolkata';
  const initialRecips = (org?.invoice_digest_recipient_emails ?? []).join(', ');

  const [enabled, setEnabled] = useState(initialEnabled);
  const [time, setTime] = useState(initialTime);
  const [tz, setTz] = useState(initialTz);
  const [recips, setRecips] = useState(initialRecips);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setEnabled(!!org?.invoice_digest_enabled);
    setTime((org?.invoice_digest_time ?? '09:00:00').slice(0, 5));
    setTz(org?.invoice_digest_timezone ?? 'Asia/Kolkata');
    setRecips((org?.invoice_digest_recipient_emails ?? []).join(', '));
  }, [org?.id]);

  const parsed = useMemo(
    () => recips.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.includes('@')),
    [recips],
  );
  const dirty = enabled !== initialEnabled || time !== initialTime || tz !== initialTz || recips !== initialRecips;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/org-settings-save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoice_digest_enabled: enabled,
          invoice_digest_time: time,
          invoice_digest_timezone: tz,
          invoice_digest_recipient_emails: parsed,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 3000);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally { setSaving(false); }
  };

  const lastSent = org?.invoice_digest_last_sent_at
    ? new Date(org.invoice_digest_last_sent_at).toLocaleString('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' })
    : null;

  return (
    <section className="bg-dark-800 border border-dark-700 rounded-xl p-5">
      <div className="flex items-start justify-between flex-wrap gap-2 mb-4">
        <div>
          <h2 className="text-white font-medium text-sm flex items-center gap-2">
            <i className="ri-time-line text-cyan-400" /> Daily digest
          </h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            One batch email at your chosen time listing every invoice received in the last 24 h. Separate from per-invoice forwarding above.
          </p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-[11px] text-gray-400">{enabled ? 'Enabled' : 'Disabled'}</span>
          <span className={`relative inline-block w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-emerald-500' : 'bg-dark-600'}`}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="sr-only"
            />
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </span>
        </label>
      </div>

      <div className={`grid grid-cols-1 md:grid-cols-3 gap-3 ${enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div>
          <label className="text-[11px] uppercase tracking-wider text-gray-500 block mb-1">Send time (local)</label>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wider text-gray-500 block mb-1">Timezone</label>
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
            {!TIMEZONES.includes(tz) && <option value={tz}>{tz}</option>}
          </select>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wider text-gray-500 block mb-1">Recipients</label>
          <input
            value={recips}
            onChange={(e) => setRecips(e.target.value)}
            placeholder="accounts@…, finance@…"
            className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-600"
          />
          <p className="text-[11px] text-gray-500 mt-1">{parsed.length > 0 ? `${parsed.length} email${parsed.length === 1 ? '' : 's'}` : 'leave empty to reuse accounts list above'}</p>
        </div>
      </div>

      <div className="flex items-center justify-between mt-4">
        <p className="text-[11px] text-gray-500">
          {lastSent
            ? `Last sent: ${lastSent} (${tz})`
            : 'Never sent yet — first run will fire at your configured time.'}
        </p>
        <div className="flex items-center gap-3">
          {savedFlash && <span className="text-[11px] text-emerald-400">✓ Saved</span>}
          {error && <span className="text-[11px] text-rose-400">{error}</span>}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-semibold disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save schedule'}
          </button>
        </div>
      </div>
    </section>
  );
}

// ── KPI row ──────────────────────────────────────────────────────────────

function KpiRow({ kpis }: { kpis: { total: number; byTier: Record<string, number>; amount: number; successRate: number; autoCount: number } }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Kpi label="This month" value={`${kpis.total}`} sub="invoices recorded" tint="emerald" />
      <Kpi label="Auto-fetched" value={`${kpis.autoCount}`} sub={`${kpis.successRate}% of total`} tint="cyan" />
      <Kpi
        label="By tier"
        value={`${kpis.byTier.api}·${kpis.byTier.email}·${kpis.byTier.scrape}`}
        sub="api · email · scrape"
        tint="violet"
      />
      <Kpi label="Forwarded value" value={kpis.amount > 0 ? `${kpis.amount.toLocaleString()}` : '—'} sub="across all currencies" tint="amber" />
    </div>
  );
}

const KPI_TINT: Record<string, string> = {
  emerald: 'from-emerald-500/15 to-emerald-500/5 text-emerald-300',
  cyan:    'from-cyan-500/15 to-cyan-500/5 text-cyan-300',
  violet:  'from-violet-500/15 to-violet-500/5 text-violet-300',
  amber:   'from-amber-500/15 to-amber-500/5 text-amber-300',
};

function Kpi({ label, value, sub, tint }: { label: string; value: string; sub: string; tint: string }) {
  return (
    <div className={`rounded-xl border border-dark-700 bg-gradient-to-br ${KPI_TINT[tint]} p-4`}>
      <p className="text-[11px] uppercase tracking-wider opacity-70">{label}</p>
      <p className="text-2xl font-semibold text-white mt-1 font-mono">{value}</p>
      <p className="text-[11px] opacity-70 mt-1">{sub}</p>
    </div>
  );
}

// ── Activity feed ────────────────────────────────────────────────────────

const EVENT_ICON: Record<string, { icon: string; cls: string }> = {
  job_queued:           { icon: 'ri-time-line',          cls: 'text-gray-400' },
  job_started:          { icon: 'ri-play-circle-line',   cls: 'text-blue-400' },
  job_completed:        { icon: 'ri-check-double-line',  cls: 'text-emerald-400' },
  job_failed:           { icon: 'ri-error-warning-line', cls: 'text-rose-400' },
  tier_api_pulled:      { icon: 'ri-plug-line',          cls: 'text-cyan-400' },
  tier_email_received:  { icon: 'ri-mail-line',          cls: 'text-violet-400' },
  tier_scrape_started:  { icon: 'ri-robot-line',         cls: 'text-fuchsia-400' },
  needs_otp:            { icon: 'ri-shield-keyhole-line', cls: 'text-amber-400' },
  otp_received:         { icon: 'ri-key-line',           cls: 'text-amber-300' },
  otp_expired:          { icon: 'ri-time-line',          cls: 'text-rose-400' },
  pdf_saved:            { icon: 'ri-file-pdf-line',      cls: 'text-emerald-400' },
  forwarded:            { icon: 'ri-mail-send-line',     cls: 'text-emerald-300' },
  forward_failed:       { icon: 'ri-mail-close-line',    cls: 'text-rose-400' },
  cron_tick:            { icon: 'ri-rss-line',           cls: 'text-gray-400' },
  channel_ping_sent:    { icon: 'ri-wifi-line',          cls: 'text-cyan-300' },
  channel_ping_failed:  { icon: 'ri-signal-wifi-off-line', cls: 'text-rose-400' },
  silent_failure_alert: { icon: 'ri-alarm-warning-line', cls: 'text-amber-400' },
};

function ActivityFeed({ events, className = '' }: { events: FetchEvent[]; className?: string }) {
  return (
    <section className={`bg-dark-800 border border-dark-700 rounded-xl ${className}`}>
      <header className="px-5 py-3 border-b border-dark-700 flex items-center justify-between">
        <div>
          <h2 className="text-white font-medium text-sm">Activity (last 80 events)</h2>
          <p className="text-[11px] text-gray-500">Updates in real-time as the fetcher works.</p>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-emerald-400">● live</span>
      </header>
      <div className="max-h-[480px] overflow-y-auto divide-y divide-dark-700/40">
        {events.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-500">No events yet. Click "Test fetch" on a credential to seed one.</p>
        ) : events.map((e) => {
          const meta = EVENT_ICON[e.kind] ?? { icon: 'ri-circle-line', cls: 'text-gray-500' };
          return (
            <div key={e.id} className="px-5 py-2.5 flex items-start gap-3 hover:bg-dark-700/20">
              <i className={`${meta.icon} ${meta.cls} text-base mt-0.5 shrink-0`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-white truncate">{e.message ?? e.kind}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  {timeAgo(e.created_at)} · {e.actor ?? '—'}
                  {e.channel ? ` · ${e.channel}` : ''}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Connections card ─────────────────────────────────────────────────────

function ConnectionsCard({ channels, crons, onTested }: { channels: ChannelStatus | null; crons: CronRun[]; onTested: () => void }) {
  const latestCron = crons.find((c) => c.name === 'invoice_fetch_tick');
  const cronAge = latestCron?.started_at ? hoursSince(latestCron.started_at) : null;
  const cronHealthy = latestCron?.ok === true && (cronAge ?? 0) < 30;       // within ~last day plus margin
  return (
    <section className="bg-dark-800 border border-dark-700 rounded-xl">
      <header className="px-5 py-3 border-b border-dark-700">
        <h2 className="text-white font-medium text-sm">Connections & health</h2>
        <p className="text-[11px] text-gray-500">Everything that needs to be live for daily fetches.</p>
      </header>
      <div className="p-3 space-y-2">
        <CronPill cron={latestCron} healthy={cronHealthy} />
        <ChannelPill name="Slack"        connected={!!channels?.slack_connected}        channel="slack"       onTested={onTested} />
        <ChannelPill name="Microsoft Teams" connected={!!channels?.teams_connected}     channel="teams"       onTested={onTested} />
        <ChannelPill name="Google Chat"  connected={!!channels?.google_chat_connected}  channel="google_chat" onTested={onTested} />
        <ChannelPill name="WhatsApp"     connected={!!channels?.whatsapp_connected}     channel="whatsapp"    onTested={onTested} />
        <Link
          to="/employees/otp-settings"
          className="block text-center text-xs text-emerald-400 hover:text-emerald-300 mt-2 py-1.5"
        >
          Manage connections →
        </Link>
      </div>
    </section>
  );
}

function CronPill({ cron, healthy }: { cron: CronRun | undefined; healthy: boolean }) {
  return (
    <div className={`px-3 py-2 rounded-lg border ${healthy ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5'} flex items-center gap-3`}>
      <i className={`ri-rss-line ${healthy ? 'text-emerald-400' : 'text-rose-400'}`} />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-white">Daily cron</p>
        <p className="text-[10px] text-gray-500">
          {cron
            ? `${timeAgo(cron.started_at)} · ${cron.ok ? 'ok' : 'failed'}${cron.enqueued != null ? ` · ${cron.enqueued} enqueued` : ''}`
            : 'never run — check vault secret + pg_cron schedule'}
        </p>
      </div>
    </div>
  );
}

function ChannelPill({ name, connected, channel, onTested }: { name: string; connected: boolean; channel: string; onTested: () => void }) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<'ok' | 'err' | null>(null);
  const test = async () => {
    setBusy(true);
    setFlash(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/otp-channel-ping`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setFlash('ok');
      setTimeout(() => setFlash(null), 4000);
      onTested();
    } catch (e) {
      setFlash('err');
      alert(`Test ping failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };
  return (
    <div className={`px-3 py-2 rounded-lg border flex items-center gap-3 ${connected ? 'border-dark-700 bg-dark-900/40' : 'border-dark-700/50 bg-dark-900/20'}`}>
      <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-gray-600'}`} />
      <p className={`text-xs flex-1 ${connected ? 'text-white' : 'text-gray-500'}`}>{name}</p>
      {connected ? (
        <button onClick={test} disabled={busy} className="text-[11px] text-cyan-400 hover:text-cyan-300 disabled:opacity-40">
          {busy ? '…' : flash === 'ok' ? '✓ Sent' : flash === 'err' ? '✗ Failed' : 'Test ping'}
        </button>
      ) : (
        <Link to="/employees/otp-settings" className="text-[11px] text-amber-400 hover:text-amber-300">Connect →</Link>
      )}
    </div>
  );
}

// ── Coverage matrix ──────────────────────────────────────────────────────

const STATE_TINT: Record<CoverageRow['state'], string> = {
  covered: 'bg-emerald-500/25 text-emerald-100',
  pending: 'bg-amber-500/20 text-amber-100',
  missing: 'bg-rose-500/25 text-rose-100',
  na:      'bg-dark-700 text-gray-600',
};
const STATE_ICON: Record<CoverageRow['state'], string> = {
  covered: '✓', pending: '⏳', missing: '⚠', na: '—',
};

function CoverageMatrix({ coverage }: { coverage: CoverageRow[] }) {
  // Bucket by credential, then sort months chronologically.
  const grouped = useMemo(() => {
    const m = new Map<string, { platform: string; months: CoverageRow[] }>();
    for (const r of coverage) {
      const cur = m.get(r.credential_id) ?? { platform: r.platform_name, months: [] };
      cur.months.push(r);
      m.set(r.credential_id, cur);
    }
    for (const v of m.values()) {
      v.months.sort((a, b) => a.month_start.localeCompare(b.month_start));
    }
    return Array.from(m.entries()).sort((a, b) => a[1].platform.localeCompare(b[1].platform));
  }, [coverage]);

  const monthLabels = useMemo(() => {
    const first = grouped[0]?.[1].months ?? [];
    return first.map((m) => new Date(m.month_start).toLocaleString('en-US', { month: 'short', year: '2-digit' }));
  }, [grouped]);

  if (grouped.length === 0) {
    return (
      <section className="bg-dark-800 border border-dark-700 rounded-xl p-5 text-sm text-gray-500">
        No credentials in the vault yet. Add some in the Credentials Vault to see coverage here.
      </section>
    );
  }

  return (
    <section className="bg-dark-800 border border-dark-700 rounded-xl">
      <header className="px-5 py-3 border-b border-dark-700 flex items-center justify-between">
        <div>
          <h2 className="text-white font-medium text-sm">6-month coverage</h2>
          <p className="text-[11px] text-gray-500">Green = invoice received · Amber = current period pending · Red = expected but missing.</p>
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase tracking-wider">
            <tr className="border-b border-dark-700">
              <th className="px-4 py-2 text-left font-medium">Platform</th>
              {monthLabels.map((m) => <th key={m} className="px-2 py-2 text-center font-medium">{m}</th>)}
            </tr>
          </thead>
          <tbody>
            {grouped.map(([credId, info]) => (
              <tr key={credId} className="border-b border-dark-700/40 hover:bg-dark-700/20">
                <td className="px-4 py-2 text-white">{info.platform}</td>
                {info.months.map((m) => (
                  <td key={m.month_start} className="px-2 py-2 text-center">
                    <span
                      className={`inline-flex items-center justify-center w-8 h-7 rounded-md text-xs ${STATE_TINT[m.state]}`}
                      title={`${info.platform} · ${m.month_start.slice(0, 7)} · ${m.state}${m.invoice_count ? ` · ${m.invoice_count} invoice(s)` : ''}`}
                    >
                      {STATE_ICON[m.state]}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}
