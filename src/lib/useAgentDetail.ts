import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabase';
import type { AlertRow } from './dataHooks';
import { formatDurationShort } from './labels';

// Shape the agent-detail page components consume. Keeps mock-era prop signatures unchanged
// so we don't have to touch the JSX.
export type AgentDetail = {
  id: string;
  orgId: string | null;
  name: string;
  machine: string;
  department: string;
  os: string;
  status: 'online' | 'idle' | 'offline';
  version: string;
  ipAddress: string;
  firstLogin: string;
  lastActivity: string;
  stillActive: boolean;
  logins: number;
  logouts: number;
  systemOn: string;
  activeWorked: string;
  screenshotsEnabled: boolean;
  videosEnabled: boolean;
  dlpEnabled: boolean;
  removableDisksBlocked: boolean;
  wallpaperEnforced: boolean;
  trackingScheduleOverride: boolean;
  screenshotIntervalSecs: number;
  videoIntervalSecs: number;
  totalActiveTime: string;
  appsUsed: number;
  sitesVisited: number;
  screenshotsCount: number;
  videosCount: number;
  alertsCount: number;
  sessionsCount: number;
  idleTime: string;
  /** Raw seconds behind activeWorked / systemOn, so callers computing a share
   *  don't have to parse the formatted strings back into numbers. */
  activeSeconds: number;
  systemOnSeconds: number;
  /** Calendar days in the window that have any activity — the System On figure
   *  is the sum of that many per-day spans, so the label has to say which. */
  daysCovered: number;
  timeline: { time: string; events: number; active: number; idle: number }[];
  /** Minutes per timeline bar. The bucket is sized to the window, so the chart
   *  must be told what it's showing instead of claiming "per hour". */
  timelineBucketMinutes: number;
  appsTime: { name: string; percent: number; time: string; color: string }[];
};

const APP_COLORS = [
  'bg-emerald-500', 'bg-teal-500', 'bg-amber-500', 'bg-orange-500',
  'bg-blue-500', 'bg-violet-500', 'bg-pink-500', 'bg-rose-500',
  'bg-cyan-500', 'bg-purple-500',
];

const formatDateTime = (iso: string | null) => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
};

type ActivityRow = {
  activity_type: 'app' | 'browser' | 'idle' | 'screenshot' | 'video' | 'alert' | 'session_start';
  application_name: string | null;
  url: string | null;
  page_title: string | null;
  duration: number | null;
  screenshot_url: string | null;
  video_url: string | null;
  created_at: string;
};

// Either a preset name, or a "custom:<fromISO>|<toISO>" string emitted by the
// DateFilter popover when the user picks specific start + end timestamps.
export type DateRange = 'today' | 'yesterday' | '7d' | '30d' | 'all' | `custom:${string}|${string}`;

function rangeBounds(r: DateRange): { since: Date; until: Date } {
  if (typeof r === 'string' && r.startsWith('custom:')) {
    const [fromIso, toIso] = r.slice('custom:'.length).split('|');
    const since = fromIso ? new Date(fromIso) : new Date(0);
    const until = toIso ? new Date(toIso) : new Date();
    return { since, until };
  }
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (r) {
    case 'today':     return { since: startOfToday, until: now };
    case 'yesterday': {
      const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
      return { since: startOfYesterday, until: startOfToday };
    }
    case '7d':  { const s = new Date(startOfToday); s.setDate(s.getDate() - 6); return { since: s, until: now }; }
    case '30d': { const s = new Date(startOfToday); s.setDate(s.getDate() - 29); return { since: s, until: now }; }
    case 'all': return { since: new Date(0), until: now };
  }
  // Fallback (TS exhaustiveness happy path)
  return { since: startOfToday, until: now };
}

export function useAgentDetail(agentId: string | undefined, range: DateRange = 'today') {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Suppress realtime-triggered refreshes for a short window after a save.
  // The agent heartbeats every ~30s and fires an UPDATE notification on the
  // `agents` row. Without this guard the heartbeat-driven refresh races with
  // the save's own refresh — and whichever fetch RETURNS LAST wins. If the
  // heartbeat fetch leaves PostgREST AFTER the save's UPDATE has committed,
  // it returns the new value (fine). If it left BEFORE the save committed,
  // it returns the stale OLD value and snaps the form back. Blocking
  // realtime refreshes for 3 s after a save is enough to let the
  // save's own refresh win deterministically.
  const suppressRealtimeUntil = useRef(0);

  const refresh = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    setNotFound(false);

    const { data: agentRow, error: agentErr } = await supabase
      .from('agents_with_seat')
      .select('*')
      .eq('id', agentId)
      .maybeSingle();

    if (agentErr || !agentRow) {
      setNotFound(true);
      setAgent(null);
      setLoading(false);
      return;
    }

    const { since, until } = rangeBounds(range);
    // Split into per-type queries. The single combined query previously
    // capped at 5000 rows and sorted ascending — for an agent with 15K+
    // app/browser rows in a 7-day window, the limit was hit by app+browser
    // alone and screenshots/videos (which are far rarer and timestamped
    // later) never made it into the result set. Symptom: dashboard showed
    // "0 screenshots / 0 videos" even though the DB had hundreds.
    //
    // Per-type queries with type-appropriate caps:
    //   • app + browser + idle + session_start → big limit for the timeline
    //   • screenshot → 1000 most recent (descending)
    //   • video      → 500 most recent (descending)
    // Build a FRESH PostgrestFilterBuilder per call — the supabase-js
    // filter builder is stateful and chaining .in/.eq on a shared instance
    // accumulates filters across all parallel branches, producing an empty
    // result. Each query gets its own pipeline below.
    const sinceISO = since.toISOString();
    const untilISO = until.toISOString();
    const cols = 'activity_type, application_name, url, page_title, duration, screenshot_url, video_url, created_at';

    const [
      { data: timelineData },
      { data: screenshotData },
      { data: videoData },
      { data: alertData },
    ] = await Promise.all([
      supabase.from('activity_logs').select(cols)
        .eq('agent_id', agentId)
        .gte('created_at', sinceISO).lte('created_at', untilISO)
        .in('activity_type', ['app', 'browser', 'idle', 'session_start'])
        .order('created_at', { ascending: true })
        .limit(20000),
      supabase.from('activity_logs').select(cols)
        .eq('agent_id', agentId)
        .gte('created_at', sinceISO).lte('created_at', untilISO)
        .eq('activity_type', 'screenshot')
        .order('created_at', { ascending: false })
        .limit(1000),
      supabase.from('activity_logs').select(cols)
        .eq('agent_id', agentId)
        .gte('created_at', sinceISO).lte('created_at', untilISO)
        .eq('activity_type', 'video')
        .order('created_at', { ascending: false })
        .limit(500),
      // Same window as everything else. Without the range filter the KPI read
      // "raised in the window" while actually counting the agent's last 50
      // alerts ever — Today and 7 days both showed the same number.
      supabase
        .from('alerts')
        .select('*')
        .eq('agent_id', agentId)
        .gte('created_at', sinceISO).lte('created_at', untilISO)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    const actData = [
      ...(timelineData ?? []),
      ...(screenshotData ?? []),
      ...(videoData ?? []),
    ];
    setActivity(actData as ActivityRow[]);
    setAlerts(
      (alertData ?? []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        agent_id: r.agent_id as string,
        agent_name: agentRow.agent_name as string,
        alert_type: r.alert_type as string,
        message: r.message as string,
        ai_resolved: !!r.ai_resolved,
        resolution: (r.resolution as string | null) ?? null,
        created_at: r.created_at as string,
      })),
    );
    setAgent(buildDetail(agentRow, (actData ?? []) as ActivityRow[], (alertData ?? []).length));
    setLoading(false);
  }, [agentId, range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime subscription: as soon as the agent inserts a new activity_log
  // row (screenshot, video, focus session) or alert for THIS agent, the
  // server pushes the change here and we re-fetch. No more "wait a minute
  // then refresh" — screenshots appear in the dashboard the instant they
  // land on the server. Same pattern the DLP page already uses for events.
  useEffect(() => {
    if (!agentId) return;
    const channel = supabase
      .channel(`agent:${agentId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'activity_logs', filter: `agent_id=eq.${agentId}` },
        () => { void refresh(); },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'alerts', filter: `agent_id=eq.${agentId}` },
        () => { void refresh(); },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agents', filter: `id=eq.${agentId}` },
        () => {
          // Skip realtime refresh during the post-save guard window.
          if (Date.now() < suppressRealtimeUntil.current) return;
          void refresh();
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [agentId, refresh]);

  // Caller (the page) invokes this right before a save. It tells us:
  // "ignore realtime UPDATE pings on the agents table for 3 s — my save's
  // own refresh is authoritative."
  const beginSaveWindow = useCallback(() => {
    suppressRealtimeUntil.current = Date.now() + 3000;
  }, []);

  return { agent, activity, alerts, loading, notFound, refresh, beginSaveWindow };
}

function buildDetail(
  agentRow: Record<string, unknown>,
  activity: ActivityRow[],
  alertCount: number,
): AgentDetail {
  const apps = activity.filter((a) => a.activity_type === 'app');
  const browser = activity.filter((a) => a.activity_type === 'browser');
  const screenshots = activity.filter((a) => a.activity_type === 'screenshot');
  const videos = activity.filter((a) => a.activity_type === 'video');
  const sessions = activity.filter((a) => a.activity_type === 'session_start');

  // `activity[]` is a concatenation of THREE sub-arrays with different
  // sort orders — timelineData ascending, screenshotData + videoData
  // descending. So `activity[0]` and `activity[activity.length-1]` are
  // NOT the earliest / latest rows overall. Prior code did that and
  // Aditya Pandey (WE-IN-35) 2026-07-24 hit it: lastActivity resolved
  // to the OLDEST screenshot (~09:47 IST) instead of the real last row
  // (~17:06 IST), collapsing the wall-clock window to 60 seconds and
  // pinning System On + Active/Worked cards at 0h 00m even though
  // 24,334 s of app/browser focus was recorded that day.
  //
  // Compute the true min/max across every row instead.
  let earliestMs = Infinity;
  let latestMs = -Infinity;
  for (const r of activity) {
    const t = new Date(r.created_at).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < earliestMs) earliestMs = t;
    if (t > latestMs) latestMs = t;
  }
  const firstActivity = Number.isFinite(earliestMs) ? new Date(earliestMs).toISOString() : null;
  const lastActivity  = Number.isFinite(latestMs)   ? new Date(latestMs).toISOString()   : null;

  // System On + Idle + Active semantics — customer feedback 2026-07-24:
  // "if agent logged in 09:46 and logged out 17:06 (wall 7h 20m), showing
  // Active 5h 46m + Idle 15m (= 6h 01m accounted) is wrong; 1h 19m has to
  // land somewhere". Customer's next clarification: "if laptop is on for
  // 10 min with no activity, it should count as idle". So gaps must
  // roll into IDLE, not vanish into nowhere and not count as active.
  //
  // Formula:
  //   System On = wall clock (first → last activity), capped to range.
  //   Idle      = max(explicit idle-row sum, wall - focus)
  //               — takes the LARGER of what the agent explicitly
  //                 flagged (>= 5 min of true keyboard/mouse idle) and
  //                 the wall-clock gap not covered by any tracked
  //                 app/browser row (walked-away-at-EOD, screensaver,
  //                 brief AFKs below the 5-min agent threshold).
  //   Active    = System On - Idle.
  //
  // Aditya Pandey 2026-07-24 example:
  //   wall_sec        26 400 s (7h 20m)
  //   focus_sec       24 334 s (6h 45m)
  //   explicit idle      966 s (16m)
  //   → System On     7h 20m
  //   → Idle          max(16m, 35m) = 35m   ← gap now credited as idle
  //   → Active        6h 45m                 ← matches focused time
  //
  // APPLIED PER CALENDAR DAY, then summed. First → last across a MULTI-day
  // range spans the nights in between: on a 7-day range the old end-to-end
  // wall clock reported System On 158h and Idle 131h for an agent that was
  // actually up ~6h a day, and the "% of system-on" share on the KPI strip
  // read 17% instead of ~64%. Active came out right only because it is
  // wall − idle and the two errors cancelled.
  //
  // Bucketing by the viewer's local day is what makes it correct AND keeps
  // single-day ranges byte-identical to the agreed formula above.
  const dayKey = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };

  type DayBucket = { firstMs: number; lastMs: number; focusSec: number; idleSec: number };
  const days = new Map<string, DayBucket>();
  const bucketFor = (iso: string) => {
    const key = dayKey(iso);
    let b = days.get(key);
    if (!b) {
      b = { firstMs: Infinity, lastMs: -Infinity, focusSec: 0, idleSec: 0 };
      days.set(key, b);
    }
    return b;
  };
  for (const r of activity) {
    const t = new Date(r.created_at).getTime();
    if (!Number.isFinite(t)) continue;
    const b = bucketFor(r.created_at);
    if (t < b.firstMs) b.firstMs = t;
    if (t > b.lastMs) b.lastMs = t;
    if (r.activity_type === 'app' || r.activity_type === 'browser') b.focusSec += r.duration ?? 0;
    if (r.activity_type === 'idle') b.idleSec += r.duration ?? 0;
  }

  // A day can't be on for more than 24h, whatever the timestamps say.
  const DAY_SEC = 24 * 60 * 60;
  let systemOnSec = 0;
  let effectiveIdleSec = 0;
  for (const b of days.values()) {
    if (!Number.isFinite(b.firstMs) || !Number.isFinite(b.lastMs)) continue;
    const wall = Math.min(DAY_SEC, Math.max(0, Math.floor((b.lastMs - b.firstMs) / 1000)));
    // Explicit idle rows and focus rows overlap (the agent emits idle
    // separately even while an app is still marked focused), so take the max
    // not the sum — summing would double-count.
    const idleForDay = Math.min(wall, Math.max(b.idleSec, Math.max(0, wall - b.focusSec)));
    systemOnSec += wall;
    effectiveIdleSec += idleForDay;
  }
  const totalActiveSec = Math.max(0, systemOnSec - effectiveIdleSec);

  // Display in whole minutes, with Idle taken as (System On − Active) in that
  // same minute space. Formatting the three independently lets rounding break
  // the identity the customer explicitly asked for — "System On = Active +
  // Idle, nothing unaccounted" — by a minute.
  const sysMin = Math.floor(systemOnSec / 60);
  const activeMin = Math.min(sysMin, Math.floor(totalActiveSec / 60));
  const idleMin = sysMin - activeMin;

  const appBuckets = new Map<string, number>();
  for (const r of apps) {
    if (!r.application_name) continue;
    appBuckets.set(r.application_name, (appBuckets.get(r.application_name) ?? 0) + (r.duration ?? 0));
  }
  const totalAppSec = Array.from(appBuckets.values()).reduce((a, b) => a + b, 0);
  const appsTime = Array.from(appBuckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, sec], i) => ({
      name,
      percent: totalAppSec > 0 ? Math.round((sec / totalAppSec) * 100) : 0,
      time: formatDurationShort(sec),
      color: APP_COLORS[i % APP_COLORS.length],
    }));

  const sites = new Set<string>();
  for (const r of browser) {
    if (r.url) sites.add(extractHost(r.url));
  }

  // ~16-bucket timeline. We always cover the full [firstActivity, lastActivity]
  // span by sizing the slot adaptively (min 30 min, larger if the span is wide).
  // Prior bug: fixed 30-min slots × cap-16 silently truncated a 24h window to the
  // FIRST 8h, hiding all recent activity.
  const timeline: AgentDetail['timeline'] = [];
  let timelineBucketMinutes = 60;
  if (firstActivity) {
    const startMs = new Date(firstActivity).getTime();
    const endMs = Math.max(
      lastActivity ? new Date(lastActivity).getTime() : Date.now(),
      startMs + 60_000,
    );
    const TARGET_BUCKETS = 16;
    const minSlot = 30 * 60 * 1000;
    const slotMs = Math.max(minSlot, Math.ceil((endMs - startMs) / TARGET_BUCKETS));
    const cap = Math.max(1, Math.ceil((endMs - startMs) / slotMs));
    timelineBucketMinutes = Math.round(slotMs / 60000);
    for (let i = 0; i < cap; i++) {
      const slotStart = startMs + i * slotMs;
      const slotEnd = slotStart + slotMs;
      let events = 0;
      let active = 0;
      let idleSec = 0;
      for (const r of activity) {
        const t = new Date(r.created_at).getTime();
        if (t < slotStart || t >= slotEnd) continue;
        events++;
        if (r.activity_type === 'app' || r.activity_type === 'browser') active += r.duration ?? 0;
        else if (r.activity_type === 'idle') idleSec += r.duration ?? 0;
      }
      // Once a bar covers several hours the window spans days, and a bare
      // clock time repeats across them — "12 AM" four times over means nothing.
      const label = slotMs >= 6 * 60 * 60 * 1000
        ? new Date(slotStart).toLocaleDateString([], { day: '2-digit', month: 'short' })
        : new Date(slotStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      timeline.push({
        time: label,
        events,
        active: Math.round(active / 60),
        idle: Math.round(idleSec / 60),
      });
    }
  }

  // Derive status from last_active freshness — see dataHooks.ts comment for why
  // we ignore the stored `status` field once the agent goes dark.
  const lastActiveStr = agentRow.last_active as string | null;
  const ageSecs = lastActiveStr
    ? (Date.now() - new Date(lastActiveStr).getTime()) / 1000
    : Infinity;
  const status: 'online' | 'idle' | 'offline' = ageSecs > 150
    ? 'offline'
    : ((agentRow.status as 'online' | 'idle' | 'offline') ?? 'online');

  return {
    id: agentRow.id as string,
    orgId: (agentRow.org_id as string | null) ?? null,
    name: (agentRow.agent_name as string) ?? '—',
    machine: (agentRow.machine_name as string) ?? (agentRow.agent_name as string) ?? '—',
    department: (agentRow.department as string) ?? 'Unassigned',
    os: (agentRow.os_type as string) ?? 'Unknown',
    status,
    version: agentRow.agent_version ? `v${String(agentRow.agent_version).replace(/^v/, '')}` : '—',
    ipAddress: (agentRow.ip_address as string) ?? '—',
    firstLogin: formatDateTime(firstActivity),
    lastActivity: formatDateTime(lastActivity),
    stillActive: status === 'online',
    // Real count of session_start rows the agent emitted in this window
    // (spawn_session_start in the agent). No synthetic fallback — if the
    // agent was already running before the window started there may be 0,
    // which the "no login events" hint below explains honestly.
    logins: sessions.length,
    // Ended sessions, derived from real session boundaries: every launch
    // emits a session_start, so a new one means the prior session ended.
    // logouts = sessions started − the one still open (if agent is online).
    // Captures every restart (graceful or not) without needing a separate
    // shutdown event the OS often never lets us send.
    logouts: Math.max(0, sessions.length - (status === 'online' ? 1 : 0)),
    systemOn: formatDurationShort(sysMin * 60),
    activeWorked: formatDurationShort(activeMin * 60),
    screenshotsEnabled: (agentRow.screenshots_enabled as boolean | undefined) ?? true,
    videosEnabled: (agentRow.videos_enabled as boolean | undefined) ?? false,
    dlpEnabled: (agentRow.dlp_enabled as boolean | undefined) ?? false,
    removableDisksBlocked: (agentRow.removable_disks_blocked as boolean | undefined) ?? true,
    wallpaperEnforced: (agentRow.wallpaper_enforced as boolean | undefined) ?? true,
    trackingScheduleOverride: (agentRow.tracking_schedule_override as boolean | undefined) ?? false,
    screenshotIntervalSecs: (agentRow.screenshot_interval_secs as number | undefined) ?? 300,
    videoIntervalSecs: (agentRow.video_interval_secs as number | undefined) ?? 1800,
    totalActiveTime: formatDurationShort(activeMin * 60),
    appsUsed: appBuckets.size,
    sitesVisited: sites.size,
    screenshotsCount: screenshots.length,
    videosCount: videos.length,
    alertsCount: alertCount,
    sessionsCount: apps.length + browser.length,
    // Report effective idle (explicit rows OR unfocused wall gaps,
    // whichever's larger) so the card matches the arithmetic:
    //   System On = Active + Idle
    idleTime: formatDurationShort(idleMin * 60),
    activeSeconds: totalActiveSec,
    systemOnSeconds: systemOnSec,
    daysCovered: days.size,
    timeline,
    timelineBucketMinutes,
    appsTime,
  };
}

const extractHost = (title: string | null): string => {
  if (!title) return '—';
  const m = title.match(/(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)/i);
  return m?.[1] ?? title.slice(0, 60);
};

