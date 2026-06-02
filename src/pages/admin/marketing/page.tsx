// Super-admin marketing AI dashboard. Reads drafts written by the EC2
// host's generate.py script (daily + weekly systemd timers). Lets the
// admin review the AI's output, approve / reject / regenerate, leave
// comments, and download the assembled video + per-platform captions
// for manual posting.

import { useCallback, useEffect, useMemo, useState } from 'react';
import AdminLayout from '../AdminLayout';
import { supabase } from '@/lib/supabase';

type DraftKind = 'post' | 'short_video' | 'long_video';
type DraftStatus = 'pending' | 'approved' | 'rejected' | 'regen_requested';

interface Draft {
  id: string;
  kind: DraftKind;
  status: DraftStatus;
  trend_source: string | null;
  hook_title: string | null;
  script: string | null;
  captions: Record<string, string> | null;
  image_urls: string[] | null;
  audio_url: string | null;
  video_url: string | null;
  scheduled_for: string | null;
  openai_cost_usd: number | null;
  created_at: string;
  approved_at: string | null;
  style: string | null;
  scene_types: string[] | null;
}

// Must stay in sync with STYLE_LIBRARY keys in scripts/marketing/generate.py.
// The dropdown lists the short-form styles for short_video drafts and
// long-form styles for long_video drafts; daemon falls back to its rotation
// if the user picks one that's incompatible with the draft's kind.
const SHORT_STYLES = [
  'product-tour',
  'problem-solution',
  'feature-spotlight',
  'before-after',
  'compare-vs-competitor',
  'tutorial-walkthrough',
];
const LONG_STYLES = [
  'tutorial-walkthrough-long',
  'product-tour-long',
];

interface Settings {
  brand_voice: string;
  value_props: string[];
  target_audience: string;
  content_style: string;
  visual_style: string;
  daily_hour_utc: number;
  weekly_day: number;
  enabled: boolean;
}

type Tab = 'today' | 'history' | 'settings';

export default function AdminMarketingPage() {
  const [tab, setTab] = useState<Tab>('today');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const [{ data: ds, error: dErr }, { data: st, error: sErr }] = await Promise.all([
      supabase
        .from('marketing_drafts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(60),
      supabase
        .from('marketing_settings')
        .select('*')
        .eq('id', 1)
        .maybeSingle(),
    ]);
    if (dErr) setErr(dErr.message);
    if (sErr) setErr(sErr.message);
    setDrafts((ds as Draft[]) ?? []);
    setSettings((st as Settings | null) ?? null);
    setLoading(false);
  }, []);

  // One-click pause/resume. Flips marketing_settings.enabled. The EC2
  // generator script reads this at the start of every run and bails
  // out before any OpenAI call when it's false — no cost when paused.
  const togglePause = async () => {
    if (!settings) return;
    const next = !settings.enabled;
    if (!confirm(next ? 'Resume AI marketing generation?' : 'Pause AI marketing generation? The next cron tick will skip generating any content (no OpenAI calls, no cost).')) return;
    const { error } = await supabase
      .from('marketing_settings')
      .update({ enabled: next, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) {
      alert(`Failed: ${error.message}`);
      return;
    }
    await refresh();
  };

  useEffect(() => { void refresh(); }, [refresh]);

  // Realtime — repaint when generate.py inserts a new draft.
  useEffect(() => {
    const ch = supabase
      .channel('marketing-drafts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'marketing_drafts' }, () => void refresh())
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [refresh]);

  const today = new Date().toISOString().slice(0, 10);
  const todayDrafts = useMemo(
    () => drafts.filter((d) => d.scheduled_for === today),
    [drafts, today],
  );
  const historyDrafts = useMemo(
    () => drafts.filter((d) => d.scheduled_for !== today),
    [drafts, today],
  );

  return (
    <AdminLayout title="Marketing AI">
      <div className="space-y-4">
        {err && (
          <div className="px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">
            {err}
          </div>
        )}

        {/* Status banner — pause/resume is the primary action here */}
        <div className={`border rounded-xl p-5 transition-colors ${
          settings?.enabled === false
            ? 'bg-gradient-to-br from-amber-500/10 to-rose-500/10 border-amber-500/30'
            : 'bg-gradient-to-br from-purple-500/10 to-cyan-500/10 border-purple-500/25'
        }`}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <i className={`text-lg ${settings?.enabled === false ? 'ri-pause-circle-line text-amber-400' : 'ri-megaphone-line text-purple-400'}`} />
                <p className={`text-[11px] uppercase tracking-wider font-medium ${settings?.enabled === false ? 'text-amber-300' : 'text-purple-300'}`}>
                  AI Marketing Automation
                </p>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                  settings?.enabled === false
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                    : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30 animate-pulse'
                }`}>
                  {settings?.enabled === false ? '⏸  Paused' : '● Running'}
                </span>
              </div>
              <p className="text-sm text-gray-300">
                {settings?.enabled === false
                  ? 'AI is stopped. No videos, no images, no OpenAI calls until you resume.'
                  : 'Daily 30-second video + post · Weekly 5-minute long video. GPT-4o + DALL-E 3 + TTS + ffmpeg.'}
              </p>
              <p className="text-[11px] text-gray-500 mt-1">
                Today is {today}. {todayDrafts.length === 0 ? (settings?.enabled === false ? 'Generation paused — no draft today.' : 'No draft generated yet — daily cron fires at 06:00 UTC.') : `${todayDrafts.length} draft${todayDrafts.length === 1 ? '' : 's'} ready for review.`}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {settings && (
                <button
                  onClick={togglePause}
                  className={`px-4 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                    settings.enabled
                      ? 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border-amber-500/30'
                      : 'bg-emerald-500 hover:bg-emerald-600 text-white border-emerald-500'
                  }`}
                >
                  <i className={`mr-1.5 ${settings.enabled ? 'ri-pause-fill' : 'ri-play-fill'}`} />
                  {settings.enabled ? 'Stop AI' : 'Resume AI'}
                </button>
              )}
              <button
                onClick={() => void refresh()}
                disabled={loading}
                className="text-xs px-3 py-2 rounded-lg bg-dark-700 hover:bg-dark-600 text-white border border-dark-600 disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 bg-dark-900 rounded-lg p-1">
          {(['today', 'history', 'settings'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                tab === t ? 'bg-dark-700 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {t === 'today' ? `Today (${todayDrafts.length})` : t === 'history' ? `History (${historyDrafts.length})` : 'Prompt Settings'}
            </button>
          ))}
        </div>

        {tab === 'today' && (
          <DraftList drafts={todayDrafts} onChange={refresh} emptyMessage="No drafts yet for today. The daily cron at 06:00 UTC will populate this." />
        )}
        {tab === 'history' && (
          <DraftList drafts={historyDrafts} onChange={refresh} emptyMessage="No older drafts yet." />
        )}
        {tab === 'settings' && (
          <SettingsForm initial={settings} onSaved={refresh} />
        )}
      </div>
    </AdminLayout>
  );
}

// ---------------- Draft list ----------------

function DraftList({ drafts, onChange, emptyMessage }: {
  drafts: Draft[];
  onChange: () => void;
  emptyMessage: string;
}) {
  if (drafts.length === 0) {
    return (
      <div className="bg-dark-800 border border-dark-700 rounded-xl p-10 text-center">
        <i className="ri-inbox-archive-line text-3xl text-gray-600 mb-2 block" />
        <p className="text-sm text-gray-400">{emptyMessage}</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {drafts.map((d) => <DraftCard key={d.id} draft={d} onChange={onChange} />)}
    </div>
  );
}

// ---------------- Single draft card ----------------

function DraftCard({ draft, onChange }: { draft: Draft; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [captionTab, setCaptionTab] = useState<'linkedin' | 'x' | 'instagram' | 'facebook'>('linkedin');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<string[]>([]);

  // Marketing-media bucket is private — mint signed URLs for inline
  // playback. Super-admin's JWT has the read policy.
  useEffect(() => {
    const sign = async () => {
      const toSign: { path: string; key: 'video' | 'audio' | number }[] = [];
      if (draft.video_url) toSign.push({ path: stripPublicPrefix(draft.video_url), key: 'video' });
      if (draft.audio_url) toSign.push({ path: stripPublicPrefix(draft.audio_url), key: 'audio' });
      (draft.image_urls ?? []).forEach((u, i) => toSign.push({ path: stripPublicPrefix(u), key: i }));
      const results = await Promise.all(toSign.map((t) =>
        supabase.storage.from('marketing-media').createSignedUrl(t.path, 3600),
      ));
      const newImages: string[] = [];
      results.forEach((r, idx) => {
        const entry = toSign[idx];
        const url = r.data?.signedUrl ?? null;
        if (!url) return;
        if (entry.key === 'video') setVideoUrl(url);
        else if (entry.key === 'audio') setAudioUrl(url);
        else newImages[entry.key] = url;
      });
      setImageUrls(newImages.filter(Boolean));
    };
    void sign();
  }, [draft.id, draft.video_url, draft.audio_url, draft.image_urls]);

  const callEdge = async (fn: string, body: Record<string, unknown>) => {
    setBusy(fn);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fn}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Action failed: ${j.error ?? r.status}`);
      } else {
        onChange();
      }
    } catch (e) {
      alert(`Action failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const [regenStyle, setRegenStyle] = useState<string>('');

  const approve   = () => callEdge('marketing-approve',   { draft_id: draft.id });
  const reject    = () => callEdge('marketing-approve',   { draft_id: draft.id, reject: true });
  const regen     = () => callEdge('marketing-regenerate', regenStyle
    ? { draft_id: draft.id, style: regenStyle }
    : { draft_id: draft.id }
  );

  const availableStyles = draft.kind === 'long_video' ? LONG_STYLES : SHORT_STYLES;

  const statusColor: Record<DraftStatus, string> = {
    pending:           'bg-amber-500/15 text-amber-300 border-amber-500/30',
    approved:          'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    rejected:          'bg-rose-500/15 text-rose-300 border-rose-500/30',
    regen_requested:   'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  };
  const kindLabel: Record<DraftKind, string> = {
    post:        'Post',
    short_video: '30s Video',
    long_video:  '5min Video',
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-dark-700 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] px-2 py-0.5 rounded-full border ${statusColor[draft.status]} uppercase tracking-wider font-medium`}>
            {draft.status.replace('_', ' ')}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-dark-700 text-gray-400 border border-dark-600">
            {kindLabel[draft.kind]}
          </span>
          {draft.style && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/30"
              title={draft.scene_types?.length ? `scene mix: ${draft.scene_types.join(' · ')}` : undefined}
            >
              {draft.style}
            </span>
          )}
          <h3 className="text-sm text-white font-semibold">{draft.hook_title || '(untitled hook)'}</h3>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span>{new Date(draft.created_at).toLocaleTimeString()}</span>
          {draft.openai_cost_usd != null && (
            <span className="px-2 py-0.5 rounded bg-dark-700 border border-dark-600">${draft.openai_cost_usd}</span>
          )}
        </div>
      </div>

      {/* Body: 2-col on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-5 p-5">
        {/* Left: video / image gallery / script */}
        <div className="space-y-4 min-w-0">
          {videoUrl ? (
            <video
              src={videoUrl}
              controls
              className="w-full rounded-lg bg-black aspect-square object-contain border border-dark-700"
            />
          ) : (
            <div className="w-full aspect-square rounded-lg bg-dark-900 border border-dark-700 flex items-center justify-center text-gray-600">
              <span className="text-xs">Video assembling… check back shortly</span>
            </div>
          )}

          {imageUrls.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-2">Scene images</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                {imageUrls.map((u, i) => (
                  <a key={i} href={u} target="_blank" rel="noreferrer" className="block">
                    <img src={u} alt={`Scene ${i + 1}`} className="w-full aspect-square rounded object-cover border border-dark-700 hover:border-emerald-500/50" />
                  </a>
                ))}
              </div>
            </div>
          )}

          {draft.script && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-1">Narration script</p>
              <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-line bg-dark-900 border border-dark-700 rounded p-3 max-h-40 overflow-y-auto">
                {draft.script}
              </p>
            </div>
          )}

          {draft.trend_source && (
            <details className="text-xs text-gray-400">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-300">Source trend</summary>
              <p className="mt-2 text-[11px] whitespace-pre-line">{draft.trend_source}</p>
            </details>
          )}
        </div>

        {/* Right: captions + actions */}
        <div className="space-y-3 min-w-0">
          {/* Caption tabs */}
          <div>
            <p className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-2">Captions per platform</p>
            <div className="flex items-center gap-1 mb-2 bg-dark-900 rounded-md p-1">
              {(['linkedin', 'x', 'instagram', 'facebook'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setCaptionTab(p)}
                  className={`flex-1 px-2 py-1 rounded text-[11px] font-medium capitalize ${
                    captionTab === p ? 'bg-dark-700 text-white' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <textarea
              readOnly
              value={draft.captions?.[captionTab] ?? '—'}
              rows={8}
              className="w-full bg-dark-900 border border-dark-700 rounded px-3 py-2 text-xs text-gray-200 font-mono resize-none"
            />
            <button
              onClick={() => navigator.clipboard.writeText(draft.captions?.[captionTab] ?? '')}
              className="mt-1 text-[11px] text-cyan-400 hover:text-cyan-300"
            >
              Copy {captionTab} caption
            </button>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-dark-700">
            {draft.status === 'pending' && (
              <>
                <button
                  onClick={approve}
                  disabled={!!busy}
                  className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-50"
                >
                  {busy === 'marketing-approve' ? '…' : 'Approve'}
                </button>
                <button
                  onClick={reject}
                  disabled={!!busy}
                  className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 disabled:opacity-50"
                >
                  Reject
                </button>
                <div className="flex-1 flex gap-1.5 min-w-0">
                  <button
                    onClick={regen}
                    disabled={!!busy}
                    className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 disabled:opacity-50 min-w-0 truncate"
                    title={regenStyle ? `Regenerate with style: ${regenStyle}` : 'Regenerate (daemon picks today\'s rotation style)'}
                  >
                    {busy === 'marketing-regenerate' ? '…' : (regenStyle ? `Regen · ${regenStyle}` : 'Regenerate')}
                  </button>
                  <select
                    value={regenStyle}
                    onChange={(e) => setRegenStyle(e.target.value)}
                    disabled={!!busy}
                    title="Override the daemon's style pick for this regen"
                    className="px-2 py-2 rounded-lg text-[11px] bg-cyan-500/10 hover:bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 disabled:opacity-50 min-w-0 max-w-[140px] truncate"
                  >
                    <option value="">auto</option>
                    {availableStyles.map((st) => <option key={st} value={st}>{st}</option>)}
                  </select>
                </div>
              </>
            )}
            {videoUrl && (
              <a
                href={videoUrl}
                download
                className="px-3 py-2 rounded-lg text-xs font-medium bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-600 inline-flex items-center gap-1"
              >
                <i className="ri-download-line" /> .mp4
              </a>
            )}
            {audioUrl && (
              <a
                href={audioUrl}
                download
                className="px-3 py-2 rounded-lg text-xs font-medium bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-600 inline-flex items-center gap-1"
              >
                <i className="ri-download-line" /> .mp3
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Settings form ----------------

function SettingsForm({ initial, onSaved }: { initial: Settings | null; onSaved: () => void }) {
  const [form, setForm] = useState<Settings>(initial ?? {
    brand_voice: '',
    value_props: [],
    target_audience: '',
    content_style: '',
    visual_style: '',
    daily_hour_utc: 6,
    weekly_day: 1,
    enabled: true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => { if (initial) setForm(initial); }, [initial]);

  const save = async () => {
    setBusy(true); setErr(null); setOk(false);
    const { error } = await supabase
      .from('marketing_settings')
      .update({
        brand_voice: form.brand_voice,
        value_props: form.value_props,
        target_audience: form.target_audience,
        content_style: form.content_style,
        visual_style: form.visual_style,
        daily_hour_utc: form.daily_hour_utc,
        weekly_day: form.weekly_day,
        enabled: form.enabled,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1);
    setBusy(false);
    if (error) setErr(error.message);
    else { setOk(true); onSaved(); setTimeout(() => setOk(false), 2000); }
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 space-y-4">
      {err && <div className="px-3 py-2 rounded text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}
      {ok && <div className="px-3 py-2 rounded text-xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">Saved. The next cron run will use the new settings.</div>}

      <Field label="Brand voice" hint="One sentence describing the tone. The AI uses this verbatim in its system prompt.">
        <textarea
          value={form.brand_voice}
          onChange={(e) => setForm({ ...form, brand_voice: e.target.value })}
          rows={2}
          className="w-full bg-dark-900 border border-dark-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
        />
      </Field>

      <Field label="Value props (one per line)" hint="Bullet list of what the app does. The AI picks 1–2 per video to highlight.">
        <textarea
          value={form.value_props.join('\n')}
          onChange={(e) => setForm({ ...form, value_props: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })}
          rows={5}
          className="w-full bg-dark-900 border border-dark-700 rounded px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-emerald-500"
        />
      </Field>

      <Field label="Target audience" hint="Who watches these videos? Concrete personas land better than 'businesses'.">
        <input
          value={form.target_audience}
          onChange={(e) => setForm({ ...form, target_audience: e.target.value })}
          className="w-full bg-dark-900 border border-dark-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
        />
      </Field>

      <Field label="Content style" hint="Educational / promotional / case-study / comparison. Pick a vibe.">
        <input
          value={form.content_style}
          onChange={(e) => setForm({ ...form, content_style: e.target.value })}
          className="w-full bg-dark-900 border border-dark-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
        />
      </Field>

      <Field label="Visual style for DALL-E" hint="Appended to every image prompt — controls illustration look.">
        <input
          value={form.visual_style}
          onChange={(e) => setForm({ ...form, visual_style: e.target.value })}
          className="w-full bg-dark-900 border border-dark-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
        />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Field label="Daily UTC hour" hint="0–23. India is UTC+5:30 so 6 UTC = 11:30 AM IST.">
          <input
            type="number"
            min={0}
            max={23}
            value={form.daily_hour_utc}
            onChange={(e) => setForm({ ...form, daily_hour_utc: Math.max(0, Math.min(23, parseInt(e.target.value || '0', 10))) })}
            className="w-full bg-dark-900 border border-dark-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          />
        </Field>
        <Field label="Weekly day" hint="0=Sun 1=Mon … 6=Sat.">
          <input
            type="number"
            min={0}
            max={6}
            value={form.weekly_day}
            onChange={(e) => setForm({ ...form, weekly_day: Math.max(0, Math.min(6, parseInt(e.target.value || '0', 10))) })}
            className="w-full bg-dark-900 border border-dark-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          />
        </Field>
        <Field label="Enabled" hint="Pause the cron without losing settings.">
          <select
            value={form.enabled ? 'yes' : 'no'}
            onChange={(e) => setForm({ ...form, enabled: e.target.value === 'yes' })}
            className="w-full bg-dark-900 border border-dark-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          >
            <option value="yes">Running</option>
            <option value="no">Paused</option>
          </select>
        </Field>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-dark-700">
        <p className="text-[11px] text-gray-500">
          systemd timers fire at the configured hour. Edits apply on the next run.
        </p>
        <button
          onClick={save}
          disabled={busy}
          className="px-5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-300 font-medium mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

// `https://…/storage/v1/object/public/marketing-media/<path>` → `<path>`
// `https://…/storage/v1/object/marketing-media/<path>`        → `<path>`
function stripPublicPrefix(url: string): string {
  const m = url.match(/\/object\/(?:public\/)?marketing-media\/(.+)$/);
  return m ? m[1] : url;
}
