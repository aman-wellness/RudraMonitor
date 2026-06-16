import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

// Working-hours schedule editor. Admin picks a timezone + per-day
// start/end times. When enabled, agents in this org pause ALL capture
// (screenshots, video, USB block, DLP, activity tracking) outside the
// configured hours. Per-agent overrides live on each agent's detail page.
//
// Schedule shape persisted to organization_settings.tracking_schedule_json:
//   {
//     "tz": "Asia/Kolkata",
//     "days": {
//       "mon": [{"start":"09:00","end":"18:00"}],
//       ...
//     }
//   }

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const DAY_ORDER: { key: DayKey; label: string }[] = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

// Curated tz list — covers the common SaaS markets. Browser supports
// Intl.supportedValuesOf('timeZone') but it returns ~400 zones; this
// is a shorter, more navigable picker.
const TZ_OPTIONS = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'UTC',
];

type DaySchedule = { enabled: boolean; start: string; end: string };

const DEFAULT_DAY: DaySchedule = { enabled: false, start: '09:00', end: '18:00' };
const DEFAULT_WORKDAY: DaySchedule = { enabled: true, start: '09:00', end: '18:00' };

export default function TrackingScheduleCard() {
  const { organization } = useAuth();
  const orgId = organization?.id ?? null;

  const [enabled, setEnabled] = useState(false);
  const [tz, setTz] = useState('Asia/Kolkata');
  const [days, setDays] = useState<Record<DayKey, DaySchedule>>({
    mon: DEFAULT_WORKDAY, tue: DEFAULT_WORKDAY, wed: DEFAULT_WORKDAY,
    thu: DEFAULT_WORKDAY, fri: DEFAULT_WORKDAY,
    sat: DEFAULT_DAY, sun: DEFAULT_DAY,
  });

  const [savedJson, setSavedJson] = useState<string | null>(null);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load.
  useEffect(() => {
    if (!orgId) return;
    void (async () => {
      const { data } = await supabase
        .from('organization_settings')
        .select('tracking_schedule_enabled, tracking_schedule_json')
        .eq('org_id', orgId)
        .maybeSingle();
      const json = (data?.tracking_schedule_json as string | null) ?? null;
      setSavedJson(json);
      setSavedEnabled(!!data?.tracking_schedule_enabled);
      setEnabled(!!data?.tracking_schedule_enabled);
      if (json) {
        try {
          const parsed = JSON.parse(json) as { tz?: string; days?: Record<string, Array<{ start: string; end: string }>> };
          if (parsed.tz) setTz(parsed.tz);
          if (parsed.days) {
            setDays((prev) => {
              const next = { ...prev };
              for (const key of DAY_ORDER.map((d) => d.key)) {
                const ranges = parsed.days?.[key] ?? [];
                next[key] = ranges.length
                  ? { enabled: true, start: ranges[0].start, end: ranges[0].end }
                  : { enabled: false, start: prev[key].start, end: prev[key].end };
              }
              return next;
            });
          }
        } catch { /* leave defaults */ }
      }
    })();
  }, [orgId]);

  // Build the JSON we'd save right now.
  const currentJson = useMemo(() => {
    const out = { tz, days: {} as Record<string, Array<{ start: string; end: string }>> };
    for (const key of DAY_ORDER.map((d) => d.key)) {
      const d = days[key];
      out.days[key] = d.enabled ? [{ start: d.start, end: d.end }] : [];
    }
    return JSON.stringify(out);
  }, [tz, days]);

  const isDirty = currentJson !== savedJson || enabled !== savedEnabled;

  const handleSave = async () => {
    if (!orgId) return;
    setError(null);
    setSaving(true);
    try {
      const { error: upErr } = await supabase
        .from('organization_settings')
        .upsert(
          {
            org_id: orgId,
            tracking_schedule_enabled: enabled,
            tracking_schedule_json: currentJson,
          },
          { onConflict: 'org_id' },
        );
      if (upErr) throw upErr;
      setSavedJson(currentJson);
      setSavedEnabled(enabled);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const updateDay = (key: DayKey, patch: Partial<DaySchedule>) =>
    setDays((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-5 h-5 flex items-center justify-center">
          <i className="ri-time-line text-amber-400 text-sm" />
        </span>
        <h3 className="text-sm font-semibold text-white">Tracking Schedule</h3>
      </div>
      <p className="text-[11px] text-gray-500 mb-4">
        Limit when agents capture activity. Outside the configured hours all
        screenshots, video, USB block, DLP & activity tracking pause.
        Heartbeat continues so the dashboard shows the device is online.
      </p>

      {/* Master toggle */}
      <div className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3 mb-4">
        <div className="flex items-center gap-3">
          <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${enabled ? 'bg-amber-500/15' : 'bg-dark-700'}`}>
            <i className={`ri-calendar-schedule-line ${enabled ? 'text-amber-400' : 'text-gray-600'}`} />
          </span>
          <div>
            <p className="text-xs text-white font-medium">Enforce tracking hours</p>
            <p className="text-[11px] text-gray-500">
              {enabled ? 'Agents pause capture outside the schedule below' : 'Agents track 24/7 (default)'}
            </p>
          </div>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`w-10 h-5 rounded-full transition-colors relative ${enabled ? 'bg-amber-500' : 'bg-dark-700'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${enabled ? 'left-[22px]' : 'left-[2px]'}`} />
        </button>
      </div>

      {/* Timezone */}
      <div className={`${enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <label className="block text-[11px] text-gray-400 mb-1.5">Timezone</label>
        <select
          value={tz}
          onChange={(e) => setTz(e.target.value)}
          className="w-full bg-dark-900 border border-dark-700 rounded-md text-xs text-white px-3 py-2 mb-4 focus:outline-none focus:border-amber-500"
        >
          {TZ_OPTIONS.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>

        {/* Per-day grid */}
        <div className="space-y-2">
          {DAY_ORDER.map(({ key, label }) => {
            const d = days[key];
            return (
              <div key={key} className="flex items-center gap-3 bg-dark-900 border border-dark-700 rounded-lg p-2.5">
                <button
                  onClick={() => updateDay(key, { enabled: !d.enabled })}
                  className={`w-8 h-4 rounded-full transition-colors relative shrink-0 ${d.enabled ? 'bg-amber-500' : 'bg-dark-700'}`}
                >
                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${d.enabled ? 'left-[18px]' : 'left-[2px]'}`} />
                </button>
                <span className="text-xs text-white font-medium w-24">{label}</span>
                <div className="flex items-center gap-2 ml-auto">
                  <input
                    type="time"
                    value={d.start}
                    onChange={(e) => updateDay(key, { start: e.target.value })}
                    disabled={!d.enabled}
                    className="bg-dark-800 border border-dark-700 rounded text-[11px] text-white px-2 py-1 disabled:opacity-40 focus:outline-none focus:border-amber-500"
                  />
                  <span className="text-[11px] text-gray-500">to</span>
                  <input
                    type="time"
                    value={d.end}
                    onChange={(e) => updateDay(key, { end: e.target.value })}
                    disabled={!d.enabled}
                    className="bg-dark-800 border border-dark-700 rounded text-[11px] text-white px-2 py-1 disabled:opacity-40 focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-dark-700">
        {error && <span className="text-xs text-red-400">{error}</span>}
        {saved && (
          <span className="text-xs text-emerald-400 flex items-center gap-1">
            <i className="ri-check-line" />
            Saved — agents apply within 1 min
          </span>
        )}
        <button
          onClick={handleSave}
          disabled={!isDirty || saving}
          className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
            isDirty && !saving
              ? 'bg-amber-500/15 text-amber-400 border border-amber-500/25 hover:bg-amber-500/25'
              : 'bg-dark-700 text-gray-500 cursor-not-allowed border border-dark-700'
          }`}
        >
          {saving ? 'Saving…' : 'Save Schedule'}
        </button>
      </div>
    </div>
  );
}
