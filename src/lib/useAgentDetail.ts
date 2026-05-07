import { useEffect, useState, useCallback } from 'react';
import { supabase } from './supabase';
import type { AlertRow } from './dataHooks';

// Shape the agent-detail page components consume. Keeps mock-era prop signatures unchanged
// so we don't have to touch the JSX.
export type AgentDetail = {
  id: string;
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
  totalActiveTime: string;
  appsUsed: number;
  sitesVisited: number;
  screenshotsCount: number;
  alertsCount: number;
  sessionsCount: number;
  idleTime: string | null;
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
  activity_type: 'app' | 'browser' | 'idle' | 'screenshot' | 'alert' | 'session_start';
  application_name: string | null;
  url: string | null;
  duration: number | null;
  screenshot_url: string | null;
  created_at: string;
};

export function useAgentDetail(agentId: string | undefined) {
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

    // Pull last 24h of activity for timeline / aggregates.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [{ data: actData }, { data: alertData }] = await Promise.all([
      supabase
        .from('activity_logs')
        .select('activity_type, application_name, url, duration, screenshot_url, created_at')
        .eq('agent_id', agentId)
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(2000),
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
    setAgent(buildDetail(agentRow, (actData ?? []) as ActivityRow[], (alertData ?? []).length));
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { agent, activity, alerts, loading, notFound, refresh };
}

function buildDetail(
  agentRow: Record<string, unknown>,
  activity: ActivityRow[],
  alertCount: number,
): AgentDetail {
  const apps = activity.filter((a) => a.activity_type === 'app');
  const browser = activity.filter((a) => a.activity_type === 'browser');
  const idle = activity.filter((a) => a.activity_type === 'idle');
  const screenshots = activity.filter((a) => a.activity_type === 'screenshot');
  const sessions = activity.filter((a) => a.activity_type === 'session_start');

  const totalActiveSec = apps.concat(browser).reduce((s, r) => s + (r.duration ?? 0), 0);
  const totalIdleSec = idle.reduce((s, r) => s + (r.duration ?? 0), 0);

  const firstActivity = activity[0]?.created_at ?? null;
  const lastActivity = activity[activity.length - 1]?.created_at ?? null;

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

  // 30-min buckets across the day for the timeline chart.
  const timeline: AgentDetail['timeline'] = [];
  if (firstActivity) {
    const startMs = new Date(firstActivity).getTime();
    const endMs = lastActivity ? new Date(lastActivity).getTime() : Date.now();
    const slotMs = 30 * 60 * 1000;
    const slots = Math.max(1, Math.ceil((endMs - startMs) / slotMs));
    const cap = Math.min(slots, 16);
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

  const status = (agentRow.status as 'online' | 'idle' | 'offline') ?? 'offline';

  return {
    id: agentRow.id as string,
    name: (agentRow.agent_name as string) ?? '—',
    machine: (agentRow.machine_name as string) ?? (agentRow.agent_name as string) ?? '—',
    department: (agentRow.department as string) ?? 'Unassigned',
    os: (agentRow.os_type as string) ?? 'Unknown',
    status,
    version: 'v0.1.0',
    ipAddress: (agentRow.ip_address as string) ?? '—',
    firstLogin: formatDateTime(firstActivity),
    lastActivity: formatDateTime(lastActivity),
    stillActive: status === 'online',
    logins: sessions.length || (activity.length > 0 ? 1 : 0),
    logouts: 0,
    systemOn: formatHM(totalActiveSec + totalIdleSec),
    activeWorked: formatHM(totalActiveSec),
    screenshotsEnabled: (agentRow.screenshots_enabled as boolean | undefined) ?? true,
    videosEnabled: (agentRow.videos_enabled as boolean | undefined) ?? false,
    totalActiveTime: formatHM(totalActiveSec),
    appsUsed: appBuckets.size,
    sitesVisited: sites.size,
    screenshotsCount: screenshots.length,
    alertsCount: alertCount,
    sessionsCount: apps.length + browser.length,
    idleTime: totalIdleSec > 0 ? formatHM(totalIdleSec) : null,
    timeline,
    appsTime,
  };
}

const extractHost = (title: string | null): string => {
  if (!title) return '—';
  const m = title.match(/(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)/i);
  return m?.[1] ?? title.slice(0, 60);
};

