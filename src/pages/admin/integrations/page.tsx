import { useEffect, useMemo, useState } from 'react';
import AdminLayout from '../AdminLayout';
import { supabase } from '@/lib/supabase';

type Integration = {
  key: string;
  value: string | null;
  category: string;
  label: string;
  description: string | null;
  is_secret: boolean;
  updated_at: string;
};

type CategoryMeta = {
  title: string;
  hint: string;
  icon: string;
  accent: string;
  /** Optional sync action — shows a button at the top of the category. */
  sync?: { label: string; functionName: string; body?: Record<string, unknown> };
};

const CATEGORY_META: Record<string, CategoryMeta> = {
  'auth-oauth': {
    title: 'Sign-in Providers (OAuth)',
    hint: 'Google + Microsoft "Sign in with…" buttons. These are read by Supabase Auth directly, not our edge functions — click "Sync to Supabase Auth" after editing to push the values into the project config. Also requires SUPABASE_MANAGEMENT_TOKEN (one-time, sbp_… from your account tokens).',
    icon: 'ri-shield-user-line', accent: 'text-indigo-400',
    sync: { label: 'Sync to Supabase Auth', functionName: 'sync-oauth-providers' },
  },
  email: {
    title: 'Email — Microsoft Graph',
    hint: 'All auth emails (invites, password resets, magic links) + DLP alerts go out through Microsoft Graph using these credentials. Sender mailbox must be Exchange Online enabled.',
    icon: 'ri-mail-send-line', accent: 'text-cyan-400',
  },
  ai: {
    title: 'AI Providers',
    hint: 'Used for any AI-powered features (DLP classification, summaries, recommendations). Anthropic is the primary; OpenAI is the fallback.',
    icon: 'ri-robot-2-line', accent: 'text-violet-400',
  },
  billing: {
    title: 'Billing — Razorpay',
    hint: 'Used by invoice and subscription flows. Keep the secret value private — it lets us charge customer cards.',
    icon: 'ri-bank-card-line', accent: 'text-amber-400',
  },
  sms: {
    title: 'SMS / OTP — MSG91',
    hint: 'Used to send OTP for phone verification during customer self-signup. Get keys from https://control.msg91.com.',
    icon: 'ri-message-3-line', accent: 'text-emerald-400',
  },
  gst: {
    title: 'GST Verification',
    hint: 'GSTIN lookup for customer onboarding (auto-fills legal name + address). Sandbox provider OK for testing.',
    icon: 'ri-file-list-3-line', accent: 'text-amber-300',
  },
  auth: {
    title: 'Auth Hook Secret',
    hint: 'Shared secret between Supabase Auth and our send-auth-email edge function. Rotate this value in Supabase Dashboard → Auth → Hooks at the same time.',
    icon: 'ri-key-2-line', accent: 'text-rose-400',
  },
  general: {
    title: 'General',
    hint: 'Misc app-wide settings.',
    icon: 'ri-settings-3-line', accent: 'text-gray-400',
  },
};

export default function AdminIntegrations() {
  const [rows, setRows] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [syncBusyCat, setSyncBusyCat] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<{ cat: string; msg: string; ok: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runSync = async (cat: string, meta: CategoryMeta) => {
    if (!meta.sync) return;
    setSyncBusyCat(cat); setSyncMsg(null); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${meta.sync.functionName}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session?.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(meta.sync.body ?? {}),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setSyncMsg({ cat, msg: j.message ?? 'Synced', ok: true });
    } catch (e) {
      setSyncMsg({ cat, msg: (e as Error).message, ok: false });
    } finally {
      setSyncBusyCat(null);
      setTimeout(() => setSyncMsg((m) => (m?.cat === cat ? null : m)), 5000);
    }
  };

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('integrations')
      .select('*')
      .order('category')
      .order('label');
    if (error) setError(error.message);
    setRows((data as Integration[]) ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const out: Record<string, Integration[]> = {};
    for (const r of rows) (out[r.category] ??= []).push(r);
    return out;
  }, [rows]);

  const save = async (row: Integration) => {
    const v = drafts[row.key];
    if (v === undefined) return;
    setError(null);
    setSavingKey(row.key);
    const { error } = await supabase
      .from('integrations')
      .update({ value: v.trim() === '' ? null : v })
      .eq('key', row.key);
    setSavingKey(null);
    if (error) { setError(error.message); return; }
    setSavedKey(row.key);
    setTimeout(() => setSavedKey((k) => (k === row.key ? null : k)), 1500);
    setDrafts((d) => { const n = { ...d }; delete n[row.key]; return n; });
    await load();
  };

  return (
    <AdminLayout title="Integrations">
      <p className="text-xs text-gray-500 max-w-3xl mb-6">
        Live credentials for external services. Changes take effect within ~30 seconds — no redeploy needed.
        Secrets are stored encrypted at rest and only super admins can view or modify them.
      </p>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
          {error}
        </div>
      )}

      {loading && <p className="text-xs text-gray-500">Loading…</p>}

      <div className="space-y-6">
        {Object.entries(grouped).map(([cat, items]) => {
          const meta = CATEGORY_META[cat] ?? { title: cat, hint: '', icon: 'ri-puzzle-line', accent: 'text-gray-300' };
          return (
            <section key={cat} className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
              <header className="px-5 py-4 border-b border-dark-700 bg-dark-900/40 flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <i className={`${meta.icon} text-lg ${meta.accent}`} />
                    <h2 className="text-sm font-semibold text-white">{meta.title}</h2>
                  </div>
                  {meta.hint && <p className="text-[11px] text-gray-500 mt-1 max-w-2xl">{meta.hint}</p>}
                  {syncMsg && syncMsg.cat === cat && (
                    <p className={`text-[11px] mt-2 ${syncMsg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {syncMsg.ok ? '✓ ' : '✗ '} {syncMsg.msg}
                    </p>
                  )}
                </div>
                {meta.sync && (
                  <button
                    onClick={() => runSync(cat, meta)}
                    disabled={syncBusyCat === cat}
                    className="shrink-0 px-3 py-2 text-xs rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/25 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <i className={syncBusyCat === cat ? 'ri-loader-4-line animate-spin' : 'ri-refresh-line'} />
                    {syncBusyCat === cat ? 'Syncing…' : meta.sync.label}
                  </button>
                )}
              </header>
              <div className="divide-y divide-dark-700">
                {items.map((row) => {
                  const draft = drafts[row.key];
                  const dirty = draft !== undefined && draft !== (row.value ?? '');
                  const display = draft !== undefined ? draft : (row.value ?? '');
                  const masked = row.is_secret && !reveal[row.key];
                  const placeholder = row.value ? (row.is_secret ? '••••••••••••' : '(empty)') : '(not set)';
                  return (
                    <div key={row.key} className="px-5 py-4 flex flex-col md:flex-row md:items-center gap-4">
                      <div className="md:w-64 shrink-0">
                        <p className="text-sm text-white">{row.label}</p>
                        <p className="text-[10px] font-mono text-gray-500 mt-0.5">{row.key}</p>
                        {row.description && <p className="text-[11px] text-gray-500 mt-1">{row.description}</p>}
                      </div>
                      <div className="flex-1 flex items-center gap-2">
                        <input
                          type={masked ? 'password' : 'text'}
                          value={display}
                          placeholder={placeholder}
                          onChange={(e) => setDrafts((d) => ({ ...d, [row.key]: e.target.value }))}
                          className="flex-1 px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white font-mono placeholder-gray-600 focus:outline-none focus:border-cyan-500/50"
                        />
                        {row.is_secret && (
                          <button
                            type="button"
                            onClick={() => setReveal((r) => ({ ...r, [row.key]: !r[row.key] }))}
                            className="px-2 py-2 text-gray-400 hover:text-white"
                            title={reveal[row.key] ? 'Hide' : 'Reveal'}
                          >
                            <i className={reveal[row.key] ? 'ri-eye-off-line' : 'ri-eye-line'} />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={!dirty || savingKey === row.key}
                          onClick={() => save(row)}
                          className="px-3 py-2 text-xs rounded-lg bg-cyan-500 text-dark-950 font-medium hover:bg-cyan-400 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          {savingKey === row.key ? 'Saving…' : savedKey === row.key ? 'Saved ✓' : 'Save'}
                        </button>
                      </div>
                      <p className="md:w-40 shrink-0 text-[10px] text-gray-600 text-right hidden md:block">
                        Updated {new Date(row.updated_at).toLocaleString()}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <p className="text-[11px] text-gray-600 mt-6 max-w-3xl">
        <i className="ri-information-line mr-1" />
        Edge functions cache integration values for ~30 seconds, so changes go live almost immediately.
        If a value is left blank, the function falls back to the matching project secret (legacy behavior).
      </p>
    </AdminLayout>
  );
}
