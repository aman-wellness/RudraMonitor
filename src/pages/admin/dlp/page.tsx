import { useEffect, useState } from 'react';
import AdminLayout from '../AdminLayout';
import { supabase, type DlpAlertRecipient, type DlpSeverity } from '@/lib/supabase';

const ALL_SEVERITIES: DlpSeverity[] = ['low', 'medium', 'high', 'critical'];

const sevColor: Record<DlpSeverity, string> = {
  low:      'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  medium:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
  high:     'bg-orange-500/15 text-orange-300 border-orange-500/30',
  critical: 'bg-red-500/15 text-red-300 border-red-500/30',
};

export default function AdminDlp() {
  const [globalRecipients, setGlobalRecipients] = useState<DlpAlertRecipient[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [stats, setStats] = useState({ totalEvents: 0, last24h: 0, criticalLast24h: 0 });

  const load = async () => {
    const { data: g } = await supabase.from('dlp_alert_recipients').select('*').is('org_id', null);
    setGlobalRecipients((g as DlpAlertRecipient[]) ?? []);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [{ count: total }, { count: last24 }, { count: crit }] = await Promise.all([
      supabase.from('dlp_events').select('id', { count: 'exact', head: true }),
      supabase.from('dlp_events').select('id', { count: 'exact', head: true }).gte('occurred_at', since),
      supabase.from('dlp_events').select('id', { count: 'exact', head: true }).gte('occurred_at', since).in('ai_severity', ['high', 'critical']),
    ]);
    setStats({ totalEvents: total ?? 0, last24h: last24 ?? 0, criticalLast24h: crit ?? 0 });
  };
  useEffect(() => { load(); }, []);

  const addRecipient = async () => {
    if (!newEmail.trim()) return;
    setBusy(true); setError(null);
    const { error } = await supabase.from('dlp_alert_recipients').insert({
      org_id: null,
      email: newEmail.trim().toLowerCase(),
      full_name: newName.trim() || null,
      severities: ['critical'],
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

  return (
    <AdminLayout title="DLP Alerts">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Stat label="Total events" value={stats.totalEvents} />
          <Stat label="Last 24 hours" value={stats.last24h} />
          <Stat label="High/Critical (24h)" value={stats.criticalLast24h} accent="red" />
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Global alert recipients (Rudrans ops)</h2>
            <p className="text-xs text-gray-400 mt-1">
              These addresses receive a copy of every DLP alert across <strong>all customer organizations</strong>.
              Use for your security team / CSM bcc. Customer-specific recipients are managed by each customer in their own DLP settings.
            </p>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex flex-col sm:flex-row gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional)" className="flex-1 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white" />
            <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} type="email" placeholder="security@wellnessextract.com" className="flex-[2] bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white" />
            <button onClick={addRecipient} disabled={busy || !newEmail.trim()} className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-dark-950 text-sm font-medium disabled:opacity-50">
              Add
            </button>
          </div>

          <div className="space-y-2 mt-2">
            {globalRecipients.map((r) => (
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
            {globalRecipients.length === 0 && <p className="text-xs text-gray-500 text-center py-3">No global recipients yet.</p>}
          </div>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-white">Microsoft Graph (sender) — env vars</h2>
          <p className="text-xs text-gray-400">
            DLP alert emails are sent via the Graph API using app-only credentials. Set these as Supabase function secrets:
          </p>
          <pre className="bg-dark-900 border border-dark-700 rounded-lg p-3 text-[12px] font-mono text-cyan-300 overflow-x-auto">{`MICROSOFT_TENANT_ID       = <Azure AD tenant GUID>
MICROSOFT_CLIENT_ID       = <App registration → Overview → Application (client) ID>
MICROSOFT_CLIENT_SECRET   = <App registration → Certificates & secrets → New secret>
MICROSOFT_SENDER_UPN      = alerts@yourdomain.onmicrosoft.com  # mailbox UPN

# Set via:
supabase secrets set MICROSOFT_TENANT_ID=...
supabase secrets set MICROSOFT_CLIENT_ID=...
supabase secrets set MICROSOFT_CLIENT_SECRET=...
supabase secrets set MICROSOFT_SENDER_UPN=...`}</pre>
          <p className="text-[11px] text-gray-400">
            App registration: <a className="text-cyan-400" href="https://entra.microsoft.com/" target="_blank" rel="noreferrer">Microsoft Entra admin centre</a> → App registrations → New →
            then under <strong>API permissions</strong> add <code className="text-cyan-300">Mail.Send</code> (Application) and grant admin consent.
          </p>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-white">AI classifier — env vars</h2>
          <pre className="bg-dark-900 border border-dark-700 rounded-lg p-3 text-[12px] font-mono text-cyan-300 overflow-x-auto">{`ANTHROPIC_API_KEY  = sk-ant-...   # primary classifier (Claude Haiku 4.5)
OPENAI_API_KEY     = sk-...      # fallback when Anthropic fails

supabase secrets set ANTHROPIC_API_KEY=...
supabase secrets set OPENAI_API_KEY=...`}</pre>
          <p className="text-[11px] text-gray-400">
            Without either key, dlp-ingest falls back to a static heuristic (USB transfers + personal-mail recipients are flagged by default).
          </p>
        </div>
      </div>
    </AdminLayout>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: 'red' }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-wider text-gray-400">{label}</p>
      <p className={`text-2xl font-semibold mt-1 ${accent === 'red' ? 'text-red-400' : 'text-white'}`}>{value}</p>
    </div>
  );
}
