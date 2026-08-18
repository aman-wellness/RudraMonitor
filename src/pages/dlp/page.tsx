import { useEffect, useState, useMemo } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/lib/useFeatures';
import UpgradeRequired from '@/components/UpgradeRequired';
import {
  supabase,
  type DlpEvent,
  type DlpAlertRecipient,
  type DlpSettings,
  type DlpSeverity,
} from '@/lib/supabase';

type Tab = 'usb' | 'email' | 'settings';

const sevColor: Record<DlpSeverity, string> = {
  low:      'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  medium:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
  high:     'bg-orange-500/15 text-orange-300 border-orange-500/30',
  critical: 'bg-red-500/15 text-red-300 border-red-500/30',
};

const ALL_SEVERITIES: DlpSeverity[] = ['low', 'medium', 'high', 'critical'];

export default function DlpPage() {
  const { organization } = useAuth();
  const features = useFeatures();
  const [tab, setTab] = useState<Tab>('usb');

  // Gate the whole page behind the DLP feature flag. While useFeatures is
  // still resolving, fall through to the normal render — we don't want a
  // flash of "upgrade required" on every fresh page-load.
  if (!features.loading && !features.dlp_enabled) {
    return (
      <DashboardLayout>
        <UpgradeRequired
          feature="Data Loss Prevention"
          icon="ri-shield-keyhole-line"
          blurb="DLP monitors USB transfers, email attachments, and clipboard exfiltration with AI-powered classification. Available on Professional or as an add-on to Starter."
        />
      </DashboardLayout>
    );
  }
  const [rows, setRows] = useState<(DlpEvent & { agents?: { agent_name: string } | null })[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch events
  const load = async () => {
    if (!organization) return;
    setLoading(true);
    const eventType = tab === 'usb' ? 'usb_transfer' : 'email_attachment';
    if (tab !== 'settings') {
      const { data } = await supabase
        .from('dlp_events')
        .select('*, agents(agent_name)')
        .eq('org_id', organization.id)
        .eq('event_type', eventType)
        .order('occurred_at', { ascending: false })
        .limit(200);
      setRows(((data as unknown as (DlpEvent & { agents?: { agent_name: string } | null })[]) ?? []));
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [organization?.id, tab]);

  // Realtime: subscribe to new events for this org
  useEffect(() => {
    if (!organization || tab === 'settings') return;
    const channel = supabase.channel(`dlp:${organization.id}:${tab}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'dlp_events', filter: `org_id=eq.${organization.id}` },
        () => { void load(); }
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [organization?.id, tab]);

  return (
    <DashboardLayout>
      <div className="space-y-4 min-w-0 max-w-full">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold text-white flex items-center gap-2">
              <i className="ri-shield-keyhole-line text-cyan-400" /> Data Loss Prevention
            </h1>
            <p className="text-xs text-gray-400 mt-1">
              AI-classified transfers from this organisation. Unauthorized events trigger an email alert.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 bg-dark-900 rounded-lg p-1 w-fit">
          <TabButton active={tab === 'usb'} onClick={() => setTab('usb')} icon="ri-usb-line" label="USB Transfers" />
          <TabButton active={tab === 'email'} onClick={() => setTab('email')} icon="ri-mail-send-line" label="Email Attachments" />
          <TabButton active={tab === 'settings'} onClick={() => setTab('settings')} icon="ri-settings-3-line" label="Settings" />
        </div>

        {tab === 'settings' ? (
          <DlpSettingsPanel orgId={organization?.id ?? null} />
        ) : (
          <EventsTable rows={rows} loading={loading} mode={tab} />
        )}
      </div>
    </DashboardLayout>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        active ? 'bg-dark-700 text-white' : 'text-gray-400 hover:text-white'
      }`}
    >
      <i className={icon} /> {label}
    </button>
  );
}

function EventsTable({ rows, loading, mode }: { rows: (DlpEvent & { agents?: { agent_name: string } | null })[]; loading: boolean; mode: 'usb' | 'email' }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-400">
          <tr>
            <th className="px-4 py-3 text-left">When</th>
            <th className="px-4 py-3 text-left">Agent</th>
            <th className="px-4 py-3 text-left">{mode === 'usb' ? 'Device' : 'Mail provider'}</th>
            <th className="px-4 py-3 text-left">{mode === 'usb' ? 'File' : 'From → To'}</th>
            <th className="px-4 py-3 text-left">{mode === 'usb' ? 'Size' : 'Attachment'}</th>
            <th className="px-4 py-3 text-left">Severity</th>
            <th className="px-4 py-3 text-left">AI Reason</th>
            <th className="px-4 py-3 text-left">Alert</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-dark-700">
          {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500 text-xs">Loading…</td></tr>}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={8} className="px-4 py-12 text-center">
              <i className={`${mode === 'usb' ? 'ri-usb-line' : 'ri-mail-send-line'} text-3xl text-gray-600 block mb-2`} />
              <p className="text-sm text-gray-300">No {mode === 'usb' ? 'USB transfers' : 'email attachments'} captured yet.</p>
              <p className="text-[11px] text-gray-500 mt-1">DLP events appear here within seconds of detection.</p>
            </td></tr>
          )}
          {rows.map((e) => (
            <tr key={e.id} className="hover:bg-dark-700/30">
              <td className="px-4 py-3 text-gray-300 text-[11px] whitespace-nowrap">
                {new Date(e.occurred_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="px-4 py-3 text-white">{e.agents?.agent_name ?? '—'}</td>
              <td className="px-4 py-3 text-gray-300">
                {mode === 'usb'
                  ? <>{e.device_name ?? '—'}{e.device_serial && <div className="text-[10px] text-gray-500 font-mono">{e.device_serial}</div>}</>
                  : <>
                      <span className="capitalize">{e.mail_provider ?? '—'}</span>
                      {e.mail_url && <div className="text-[10px] text-gray-500 truncate max-w-[160px]">{mailHost(e.mail_url)}</div>}
                    </>}
              </td>
              <td className="px-4 py-3 text-gray-200 max-w-xs">
                {mode === 'usb'
                  ? <span className="truncate block">{e.file_name ?? e.file_path ?? '—'}</span>
                  : <>
                      <div className="text-[11px]"><span className="text-gray-500">From </span><span className="text-gray-200 break-all">{e.sender_email ?? '—'}</span></div>
                      <div className="text-[11px]"><span className="text-gray-500">To </span><span className="text-cyan-300 break-all">{e.recipient_email ?? '—'}</span></div>
                    </>}
              </td>
              <td className="px-4 py-3 text-gray-300 text-[11px]">
                {mode === 'usb'
                  ? (e.file_size_bytes ? formatBytes(e.file_size_bytes) : '—')
                  : (e.file_name
                      ? <>📎 {e.file_name}
                          {(e.file_size_bytes || e.file_mime) && (
                            <div className="text-[10px] text-gray-500">
                              {[e.file_size_bytes ? formatBytes(e.file_size_bytes) : null, e.file_mime].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </>
                      : '—')}
              </td>
              <td className="px-4 py-3">
                {e.ai_severity ? (
                  <span className={`px-2 py-0.5 text-[10px] rounded-md border capitalize ${sevColor[e.ai_severity]}`}>
                    {e.ai_severity}
                  </span>
                ) : <span className="text-gray-500 text-[11px]">classifying…</span>}
              </td>
              <td className="px-4 py-3 text-gray-300 text-[11px] max-w-sm">
                {e.ai_reason ?? <span className="text-gray-500">—</span>}
              </td>
              <td className="px-4 py-3 text-[11px]">
                {e.alert_sent_at ? (
                  <span className="text-emerald-300"><i className="ri-mail-check-line mr-1" />Sent</span>
                ) : e.ai_authorized === false ? (
                  <span className="text-amber-400">queued</span>
                ) : (
                  <span className="text-gray-500">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DlpSettingsPanel({ orgId }: { orgId: string | null }) {
  const [settings, setSettings] = useState<DlpSettings | null>(null);
  const [recipients, setRecipients] = useState<DlpAlertRecipient[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');

  const load = async () => {
    if (!orgId) return;
    const [{ data: s }, { data: r }] = await Promise.all([
      supabase.from('dlp_settings').select('*').eq('org_id', orgId).maybeSingle(),
      supabase.from('dlp_alert_recipients').select('*').eq('org_id', orgId).order('created_at'),
    ]);
    setSettings(s as DlpSettings | null);
    setRecipients((r as DlpAlertRecipient[]) ?? []);
  };
  useEffect(() => { load(); }, [orgId]);

  const update = async (patch: Partial<DlpSettings>) => {
    if (!orgId) return;
    setBusy(true); setError(null);
    const { error } = await supabase.from('dlp_settings').upsert({ org_id: orgId, ...settings, ...patch });
    if (error) setError(error.message);
    else await load();
    setBusy(false);
  };

  const addRecipient = async () => {
    if (!orgId || !newEmail.trim()) return;
    setBusy(true); setError(null);
    const { error } = await supabase.from('dlp_alert_recipients').insert({
      org_id: orgId,
      email: newEmail.trim().toLowerCase(),
      full_name: newName.trim() || null,
      severities: ['high', 'critical'],
    });
    if (error) setError(error.message);
    else { setNewEmail(''); setNewName(''); await load(); }
    setBusy(false);
  };

  const removeRecipient = async (id: string) => {
    await supabase.from('dlp_alert_recipients').delete().eq('id', id);
    await load();
  };

  const toggleSeverity = async (rec: DlpAlertRecipient, sev: DlpSeverity) => {
    const next = rec.severities.includes(sev) ? rec.severities.filter((s) => s !== sev) : [...rec.severities, sev];
    await supabase.from('dlp_alert_recipients').update({ severities: next }).eq('id', rec.id);
    await load();
  };

  if (!settings) return <div className="text-sm text-gray-400">Loading settings…</div>;

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-white">What to monitor</h2>
        <Toggle label="USB transfers" sub="Files copied to/from removable drives" checked={settings.usb_enabled} onChange={(v) => update({ usb_enabled: v })} disabled={busy} />
        <Toggle label="Email attachments" sub="Files attached on Gmail / Yahoo / Outlook / Rediffmail" checked={settings.email_enabled} onChange={(v) => update({ email_enabled: v })} disabled={busy} />
        <Toggle label="Clipboard exfiltration (beta)" sub="Detect large copy-paste of sensitive content into mail/chat apps" checked={settings.clipboard_enabled} onChange={(v) => update({ clipboard_enabled: v })} disabled={busy} />
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-white">Authorized email domains (whitelist)</h2>
        <p className="text-xs text-gray-400">
          Comma-separated. <strong>By default every personal-mail attachment is flagged</strong>.
          List your company / partner / client domains here so legitimate business email isn't alerted on.
          Recipients ending in <code className="text-cyan-300">@&lt;listed domain&gt;</code> become LOW severity, authorized.
        </p>
        <input
          defaultValue={settings.authorized_domains.join(', ')}
          placeholder="company.com, partner.in, client.co"
          className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white"
          onBlur={(e) => {
            const list = e.target.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
            update({ authorized_domains: list });
          }}
        />
        <p className="text-[11px] text-gray-500">
          <strong className="text-amber-300">Note:</strong> USB transfers are always flagged regardless of this list — no whitelist for removable drives.
        </p>
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-white">Custom AI policy (optional)</h2>
        <p className="text-xs text-gray-400">
          Default behaviour: <strong>track every USB transfer + every personal-mail attachment</strong>, regardless of file content.
          Add extra rules here if you want stricter classification (e.g. critical severity on specific keywords).
        </p>
        <textarea
          defaultValue={settings.ai_policy_prompt ?? ''}
          rows={3}
          placeholder='e.g. "Mark CRITICAL when file name contains payroll, customer_db, source_code, or NDA. Mark HIGH for any large transfer (>10 MB)."'
          className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white"
          onBlur={(e) => update({ ai_policy_prompt: e.target.value || null })}
        />
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-white">Alert recipients</h2>
        <p className="text-xs text-gray-400">Who should receive the DLP alert email when an unauthorized event is detected.</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional)" className="flex-1 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white" />
          <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} type="email" placeholder="alerts@company.com" className="flex-[2] bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white" />
          <button onClick={addRecipient} disabled={busy || !newEmail.trim()} className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 text-sm font-medium disabled:opacity-50">
            Add
          </button>
        </div>
        <div className="space-y-2">
          {recipients.map((r) => (
            <div key={r.id} className="flex items-center justify-between bg-dark-900 border border-dark-700 rounded-lg px-3 py-2.5">
              <div>
                <p className="text-sm text-white">{r.full_name ?? r.email}</p>
                {r.full_name && <p className="text-[11px] text-gray-400">{r.email}</p>}
              </div>
              <div className="flex items-center gap-1.5">
                {ALL_SEVERITIES.map((s) => (
                  <button key={s} onClick={() => toggleSeverity(r, s)}
                    className={`px-2 py-0.5 text-[10px] rounded-md border capitalize ${
                      r.severities.includes(s) ? sevColor[s] : 'bg-dark-700 border-dark-600 text-gray-500'
                    }`}>
                    {s}
                  </button>
                ))}
                <button onClick={() => removeRecipient(r.id)} className="text-red-400 hover:text-red-300 ml-2">
                  <i className="ri-delete-bin-line" />
                </button>
              </div>
            </div>
          ))}
          {recipients.length === 0 && <p className="text-xs text-gray-500 text-center py-3">No recipients yet — DLP alerts will go nowhere until you add one.</p>}
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, sub, checked, onChange, disabled }: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-start justify-between gap-3 cursor-pointer">
      <div>
        <p className="text-sm text-white font-medium">{label}</p>
        {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
      </div>
      <button
        type="button" disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-cyan-500' : 'bg-dark-700'} disabled:opacity-50`}
      >
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform mt-0.5 ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}

// Show a compact host for a captured webmail URL (e.g. "mail.google.com")
// rather than the full deep-link.
function mailHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}

// Suppress unused warnings (useMemo imported in case we extend later)
void useMemo;
