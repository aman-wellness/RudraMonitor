import { useEffect, useState, useCallback } from 'react';
import { supabase } from './supabase';
import type { AlertRow } from './dataHooks';

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
  screenshotIntervalSecs: number;
  videoIntervalSecs: number;
  totalActiveTime: string;
  appsUsed: number;
  sitesVisited: number;
  screenshotsCount: number;
  alertsCount: number;
  sessionsCount: number;
  idleTime: string;
  timeline: { time: string; events: number; active: number; idle: number }[];
  appsTime: { name: string; percent: number; time: string; color: string }[];
};

const APP_COLORS = [
  'bg-emerald-500', 'bg-teal-500', 'bg-amber-500', 'bg-orange-500',
  'bg-blue-500', 'bg-violet-500', 'bg-pink-500', 'bg-rose-500',
  'bg-cyan-500', 'bg-purple-500',
];

const formatHM = (totalSec: number) => {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
};

const formatHMS = (totalSec: number) => {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

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

  const refresh = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    setNotFound(false);

    const { data: agentRow, error: agentErr } = await supabase
      .from('agents')
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
    const [{ data: actData }, { data: alertData }] = await Promise.all([
      supabase
        .from('activity_logs')
        .select('activity_type, application_name, url, page_title, duration, screenshot_url, video_url, created_at')
        .eq('agent_id', agentId)
        .gte('created_at', since.toISOString())
        .lte('created_at', until.toISOString())
        .order('created_at', { ascending: true })
        .limit(5000),
      supabase
        .from('alerts')
        .select('*')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    setActivity((actData ?? []) as ActivityRow[]);
    setAlerts(
      (alertData ?? []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        agent_id: r.agent_id as string,
        agent_name: agentRow.agent_name as string,
        alert_type: r.alert_type as 'error' | 'warning' | 'info',
        message: r.message as string,
        ai_resolved: !!r.ai_resolved,
        resolution: (r.resolution as string | null) ?? null,
        created_at: r.created_at as string,
      })),
    );
    setAgent(buildDetail(agentRow, (actData ?? []) as ActivityRow[], (alertData ?? []).length, since, until));
    setLoading(false);
  }, [agentId, range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { agent, activity, alerts, loading, notFound, refresh };
}

function buildDetail(
  agentRow: Record<string, unknown>,
  activity: ActivityRow[],
  alertCount: number,
  rangeStart?: Date,
  rangeEnd?: Date,
): AgentDetail {
  const apps = activity.filter((a) => a.activity_type === 'app');
  const browser = activity.filter((a) => a.activity_type === 'browser');
  const idle = activity.filter((a) => a.activity_type === 'idle');
  const screenshots = activity.filter((a) => a.activity_type === 'screenshot');
  const sessions = activity.filter((a) => a.activity_type === 'session_start');

  // Focus session durations include time the user was idle on that window
  // (the agent emits the focus row when the window changes; idle is tracked
  // separately and overlaps with the focus row). So focus-row sums double-count
  // idle time. Real time the user was actively using the keyboard/mouse =
  // focus minus idle, both clamped to the wall-clock window so we never report
  // > 24h for a "today" view.
  const rawFocusSec = apps.concat(browser).reduce((s, r) => s + (r.duration ?? 0), 0);
  const totalIdleSec = idle.reduce((s, r) => s + (r.duration ?? 0), 0);

  const firstActivity = activity[0]?.created_at ?? null;
  const lastActivity = activity[activity.length - 1]?.created_at ?? null;

  // Cap "system on" to wall-clock between first→last activity (or the selected
  // range if narrower). Without this cap, overlapping focus + idle rows can
  // sum to > 24h for a "today" view.
  const wallStart = firstActivity ? new Date(firstActivity).getTime() : null;
  const wallEnd = lastActivity ? new Date(lastActivity).getTime() : null;
  const wallSec = wallStart != null && wallEnd != null
    ? Math.max(0, Math.floor((wallEnd - wallStart) / 1000))
    : 0;
  const rangeCapSec = rangeStart && rangeEnd
    ? Math.max(0, Math.floor((rangeEnd.getTime() - rangeStart.getTime()) / 1000))
    : Infinity;
  const systemOnSec = Math.min(rawFocusSec, wallSec || rawFocusSec, rangeCapSec);
  const totalActiveSec = Math.max(0, systemOnSec - totalIdleSec);

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
      time: formatHMS(sec),
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
      const label = new Date(slotStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    logins: sessions.length || (activity.length > 0 ? 1 : 0),
    logouts: 0,
    systemOn: formatHM(systemOnSec),
    activeWorked: formatHM(totalActiveSec),
    screenshotsEnabled: (agentRow.screenshots_enabled as boolean | undefined) ?? true,
    videosEnabled: (agentRow.videos_enabled as boolean | undefined) ?? false,
    dlpEnabled: (agentRow.dlp_enabled as boolean | undefined) ?? false,
    screenshotIntervalSecs: (agentRow.screenshot_interval_secs as number | undefined) ?? 300,
    videoIntervalSecs: (agentRow.video_interval_secs as number | undefined) ?? 1800,
    totalActiveTime: formatHM(totalActiveSec),
    appsUsed: appBuckets.size,
    sitesVisited: sites.size,
    screenshotsCount: screenshots.length,
    alertsCount: alertCount,
    sessionsCount: apps.length + browser.length,
    idleTime: formatHM(totalIdleSec),
    timeline,
    appsTime,
  };
}

const extractHost = (title: string | null): string => {
  if (!title) return '—';
  const m = title.match(/(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)/i);
  return m?.[1] ?? title.slice(0, 60);
};

