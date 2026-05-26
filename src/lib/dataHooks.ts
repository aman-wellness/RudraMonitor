import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, type Agent } from './supabase';
import { useAuth } from '../context/AuthContext';

// UI-shape agent: fields the dashboard/agents pages expect.
// Derived monitoring fields (productivity/activeHours/idleTime/applications/browserUrls) start at safe
// defaults and will be populated once activity_logs / system_metrics begin flowing from the desktop agent.
export type UiAgent = {
  id: string;
  name: string;          // = agent_name
  machine: string;       // = machine_name (or agent_name if null)
  os: string;            // os_type (e.g. "Windows 11")
  status: 'online' | 'idle' | 'offline';
  lastActive: string;
  ipAddress: string;
  department: string;
  productivity: number;
  activeHours: string;
  idleTime: string;
  applications: string[];
  browserUrls: string[];
  enrollToken: string;
  // True when this agent is beyond the org's licensed seat_count. Locked
  // agents have their ingest endpoints rejecting data server-side (see
  // migration 0078 + edge functions). The dashboard hides their stream
  // and shows a "Locked — over license" badge until the customer
  // upgrades seats or removes another agent.
  seatLocked: boolean;
  seatRank: number;
};

const DEFAULT_DEPT = 'Unassigned';

// Agent heartbeat is every 60s. We give one full miss + 30s grace before
// marking offline — so 150s after the last `last_active` timestamp.
const OFFLINE_STALENESS_SECS = 150;

/**
 * The agent can't reliably tell the server "I'm going offline" — laptops get
 * suspended, networks drop, processes get killed. So we ignore the stored
 * `status` field and derive status from `last_active` freshness:
 *   - no last_active → offline
 *   - >150s stale    → offline (user closed laptop / lost wifi / killed process)
 *   - fresh          → trust the stored status (online vs user-idle, paused, etc.)
 */
const computeStatus = (a: Agent): UiAgent['status'] => {
  if (!a.last_active) return 'offline';
  const ageSecs = (Date.now() - new Date(a.last_active).getTime()) / 1000;
  if (ageSecs > OFFLINE_STALENESS_SECS) return 'offline';
  return (a.status as UiAgent['status']) ?? 'online';
};

type AgentRow = Agent & { seat_rank?: number | null; seat_locked?: boolean | null };

const toUi = (a: AgentRow): UiAgent => ({
  id: a.id,
  name: a.agent_name,
  machine: a.machine_name ?? a.agent_name,
  os: a.os_type ?? 'Unknown',
  // A locked agent stops checking in (server refuses ingest with 402), so
  // its last_active stales out and computeStatus naturally returns
  // 'offline'. Force the locked badge to win over the live status pill
  // so the UI is unambiguous about WHY it's silent.
  status: a.seat_locked ? 'offline' : computeStatus(a),
  lastActive: a.last_active ?? '-',
  ipAddress: a.ip_address ?? '-',
  department: a.department ?? DEFAULT_DEPT,
  productivity: 0,
  activeHours: '0h 0m',
  idleTime: '0m',
  applications: [],
  browserUrls: [],
  enrollToken: a.enroll_token,
  seatLocked: !!a.seat_locked,
  seatRank: a.seat_rank ?? 0,
});

export function useAgents() {
  const { organization } = useAuth();
  const [agents, setAgents] = useState<UiAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!organization) {
      setAgents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    // agents_with_seat is the view from migration 0078: same shape as the
    // agents table + seat_rank + seat_locked. Lets the UI dim/hide agents
    // that are beyond the org's licensed seat_count without re-computing
    // the rank window in JS.
    const { data, error } = await supabase
      .from('agents_with_seat')
      .select('*')
      .eq('org_id', organization.id)
      .order('created_at', { ascending: false });
    if (error) setError(error.message);
    else setAgents((data as AgentRow[]).map(toUi));
    setLoading(false);
  }, [organization]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime: any change to agents in this org → refetch.
  useEffect(() => {
    if (!organization) return;
    const channel = supabase
      .channel(`agents:${organization.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agents', filter: `org_id=eq.${organization.id}` },
        () => { void refresh(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [organization, refresh]);

  const updateDepartment = async (agentId: string, department: string) => {
    if (!organization) return;
    const prev = agents;
    setAgents((p) => p.map((a) => (a.id === agentId ? { ...a, department } : a)));
    // Defense-in-depth: RLS already scopes by org, but adding org_id to the
    // filter makes a cross-org mutation impossible even if RLS misconfigures.
    const { error } = await supabase
      .from('agents')
      .update({ department })
      .eq('id', agentId)
      .eq('org_id', organization.id);
    if (error) {
      setAgents(prev);
      setError(error.message);
    }
  };

  const createAgent = async (input: { agentName: string; machineName?: string; osType?: string; department?: string }) => {
    if (!organization) throw new Error('No organization loaded');
    const { data, error } = await supabase
      .from('agents')
      .insert({
        org_id: organization.id,
        agent_name: input.agentName,
        machine_name: input.machineName ?? input.agentName,
        os_type: input.osType ?? null,
        department: input.department ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    await refresh();
    return data as Agent;
  };

  const deleteAgent = async (agentId: string) => {
    if (!organization) throw new Error('No organization loaded');
    const { error } = await supabase
      .from('agents')
      .delete()
      .eq('id', agentId)
      .eq('org_id', organization.id);
    if (error) throw error;
    await refresh();
  };

  return { agents, loading, error, refresh, updateDepartment, createAgent, deleteAgent };
}

// =============== Activity logs ===============

export type ActivityLogRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  activity_type: 'app' | 'browser' | 'idle' | 'alert' | 'screenshot' | 'video' | 'session_start';
  application_name: string | null;
  url: string | null;
  duration: number | null;
  screenshot_url: string | null;
  video_url: string | null;
  created_at: string;
};

type ActivityFilter = {
  type?: 'app' | 'browser' | 'screenshot' | 'idle' | 'alert' | 'video';
  agentId?: string;          // 'all' or omitted = all agents
  sinceHours?: number;       // default 24
  limit?: number;            // default 500
};

export function useActivityLogs(filter: ActivityFilter = {}) {
  const { organization } = useAuth();
  const [rows, setRows] = useState<ActivityLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sinceHours = filter.sinceHours ?? 24;
  const limit = filter.limit ?? 500;
  const type = filter.type;
  const agentId = filter.agentId;

  const refresh = useCallback(async () => {
    if (!organization) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    let q = supabase
      .from('activity_logs')
      .select('id, agent_id, activity_type, application_name, url, duration, screenshot_url, video_url, created_at, agents!inner(agent_name, org_id)')
      .gte('created_at', since)
      .eq('agents.org_id', organization.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (type) q = q.eq('activity_type', type);
    if (agentId && agentId !== 'all') q = q.eq('agent_id', agentId);
    const { data, error } = await q;
    if (error) {
      setError(error.message);
      setRows([]);
    } else {
      type Joined = {
        id: string;
        agent_id: string;
        activity_type: ActivityLogRow['activity_type'];
        application_name: string | null;
        url: string | null;
        duration: number | null;
        screenshot_url: string | null;
        video_url: string | null;
        created_at: string;
        agents: { agent_name: string } | { agent_name: string }[];
      };
      const mapped: ActivityLogRow[] = (data as Joined[]).map((r) => ({
        id: r.id,
        agent_id: r.agent_id,
        agent_name: Array.isArray(r.agents) ? (r.agents[0]?.agent_name ?? '') : r.agents?.agent_name ?? '',
        activity_type: r.activity_type,
        application_name: r.application_name,
        url: r.url,
        duration: r.duration,
        screenshot_url: r.screenshot_url,
        video_url: r.video_url,
        created_at: r.created_at,
      }));
      setRows(mapped);
    }
    setLoading(false);
  }, [organization, type, agentId, sinceHours, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime: insertions on activity_logs → refetch (debounced on a short timer to avoid floods).
  useEffect(() => {
    if (!organization) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; void refresh(); }, 1500);
    };
    const channel = supabase
      .channel(`activity_logs:${organization.id}:${type ?? 'all'}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_logs' }, schedule)
      .subscribe();
    return () => {
      if (pending) clearTimeout(pending);
      void supabase.removeChannel(channel);
    };
  }, [organization, type, refresh]);

  return { rows, loading, error, refresh };
}

// =============== Organization members ===============

export type OrgMember = {
  id: string;
  user_id: string;
  org_id: string;
  role: 'owner' | 'admin' | 'viewer';
  full_name: string | null;
  email: string | null;
  created_at: string;
};

export type OrgMemberStatus = 'active' | 'pending';

export function useOrgMembers() {
  const { organization, session } = useAuth();
  const [members, setMembers] = useState<(OrgMember & { status: OrgMemberStatus })[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organization) {
      setMembers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from('org_members')
      .select('id, user_id, org_id, role, full_name, email, created_at')
      .eq('org_id', organization.id)
      .order('created_at', { ascending: true });
    setMembers(
      ((data ?? []) as (OrgMember & { user_id: string | null })[]).map((m) => ({
        ...m,
        status: m.user_id ? 'active' : 'pending',
      })),
    );
    setLoading(false);
  }, [organization]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sends a magic-link invite via the invite-member Edge Function and creates the pending
  // org_members row. The on-disk row is filled in by an auth.users trigger once the invitee
  // confirms their email.
  const inviteMember = async (input: { email: string; role: 'admin' | 'viewer'; full_name?: string }) => {
    if (!session) throw new Error('not signed in');
    const url = (import.meta.env.VITE_SUPABASE_URL as string).replace(/\/+$/, '') +
      '/functions/v1/invite-member';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error ?? `invite failed (${resp.status})`);
    }
    await refresh();
  };

  const removeMember = async (memberId: string) => {
    if (!organization) throw new Error('No organization loaded');
    const prev = members;
    setMembers((p) => p.filter((m) => m.id !== memberId));
    const { error } = await supabase
      .from('org_members')
      .delete()
      .eq('id', memberId)
      .eq('org_id', organization.id);
    if (error) {
      setMembers(prev);
      throw error;
    }
  };

  return { members, loading, refresh, inviteMember, removeMember };
}

// =============== Productivity rules ===============

export type Category = 'productive' | 'unproductive' | 'neutral';
export type MatchType = 'app' | 'host';

export type ProductivityRule = {
  id: string;
  org_id: string;
  match_type: MatchType;
  pattern: string;
  category: Category;
};

// Lookup table keyed by `${match_type}:${pattern.toLowerCase()}` for O(1) classification.
export type RuleMap = Record<string, Category>;

export const ruleKey = (matchType: MatchType, pattern: string) =>
  `${matchType}:${pattern.toLowerCase()}`;

export const classify = (rules: RuleMap, matchType: MatchType, pattern: string): Category =>
  rules[ruleKey(matchType, pattern)] ?? 'neutral';

export function useProductivityRules() {
  const { organization } = useAuth();
  const [rules, setRules] = useState<ProductivityRule[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organization) {
      setRules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from('productivity_rules')
      .select('*')
      .eq('org_id', organization.id);
    if (!error && data) setRules(data as ProductivityRule[]);
    setLoading(false);
  }, [organization]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ruleMap: RuleMap = useMemo(() => {
    const m: RuleMap = {};
    for (const r of rules) m[ruleKey(r.match_type, r.pattern)] = r.category;
    return m;
  }, [rules]);

  const upsertRule = async (matchType: MatchType, pattern: string, category: Category) => {
    if (!organization) return;
    const trimmed = pattern.trim();
    if (!trimmed) return;
    // Optimistic update keyed by (match_type, pattern).
    setRules((prev) => {
      const others = prev.filter((r) => !(r.match_type === matchType && r.pattern.toLowerCase() === trimmed.toLowerCase()));
      return [
        ...others,
        { id: 'temp', org_id: organization.id, match_type: matchType, pattern: trimmed, category },
      ];
    });
    const { error } = await supabase
      .from('productivity_rules')
      .upsert(
        { org_id: organization.id, match_type: matchType, pattern: trimmed, category },
        { onConflict: 'org_id,match_type,pattern' },
      );
    if (error) {
      void refresh();
      throw error;
    }
    void refresh();
  };

  const deleteRule = async (matchType: MatchType, pattern: string) => {
    if (!organization) return;
    const prev = rules;
    setRules((p) => p.filter((r) => !(r.match_type === matchType && r.pattern.toLowerCase() === pattern.toLowerCase())));
    const { error } = await supabase
      .from('productivity_rules')
      .delete()
      .eq('org_id', organization.id)
      .eq('match_type', matchType)
      .eq('pattern', pattern);
    if (error) {
      setRules(prev);
      throw error;
    }
  };

  return { rules, ruleMap, loading, upsertRule, deleteRule, refresh };
}

// =============== Alerts ===============

export type AlertRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  alert_type: 'error' | 'warning' | 'info';
  message: string;
  ai_resolved: boolean;
  resolution: string | null;
  created_at: string;
};

export function useAlerts(opts: { sinceHours?: number; limit?: number } = {}) {
  const { organization } = useAuth();
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);

  const sinceHours = opts.sinceHours ?? 24 * 7;
  const limit = opts.limit ?? 200;

  const refresh = useCallback(async () => {
    if (!organization) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('alerts')
      .select('id, agent_id, alert_type, message, ai_resolved, resolution, created_at, agents!inner(agent_name, org_id)')
      .gte('created_at', since)
      .eq('agents.org_id', organization.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      setRows([]);
    } else {
      type Joined = Omit<AlertRow, 'agent_name'> & {
        agents: { agent_name: string } | { agent_name: string }[];
      };
      setRows(
        (data as Joined[]).map((r) => ({
          id: r.id,
          agent_id: r.agent_id,
          agent_name: Array.isArray(r.agents) ? r.agents[0]?.agent_name ?? '' : r.agents?.agent_name ?? '',
          alert_type: r.alert_type,
          message: r.message,
          ai_resolved: r.ai_resolved,
          resolution: r.resolution,
          created_at: r.created_at,
        })),
      );
    }
    setLoading(false);
  }, [organization, sinceHours, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Realtime: new/updated alerts → refetch. RLS scopes events to this user's orgs automatically.
  useEffect(() => {
    if (!organization) return;
    const channel = supabase
      .channel(`alerts:${organization.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, () => { void refresh(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [organization, refresh]);

  const resolveAlert = async (alertId: string, resolution: string) => {
    const prev = rows;
    setRows((p) => p.map((a) => (a.id === alertId ? { ...a, ai_resolved: true, resolution } : a)));
    const { error } = await supabase
      .from('alerts')
      .update({ ai_resolved: true, resolution })
      .eq('id', alertId);
    if (error) {
      setRows(prev);
      throw error;
    }
  };

  return { rows, loading, refresh, resolveAlert };
}

// =============== Latest system metrics per agent ===============

export type MetricsRow = {
  agent_id: string;
  cpu_usage: number | null;
  ram_usage: number | null;
  disk_usage: number | null;
  battery_level: number | null;
  network_speed: string | null;
  recorded_at: string;
};

export function useLatestSystemMetrics() {
  const { organization } = useAuth();
  const [byAgent, setByAgent] = useState<Record<string, MetricsRow>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organization) {
      setByAgent({});
      setLoading(false);
      return;
    }
    setLoading(true);
    // Pull last 30 min, take latest per agent client-side. The dataset is small for typical orgs.
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('system_metrics')
      .select('agent_id, cpu_usage, ram_usage, disk_usage, battery_level, network_speed, recorded_at, agents!inner(org_id)')
      .gte('recorded_at', since)
      .eq('agents.org_id', organization.id)
      .order('recorded_at', { ascending: false })
      .limit(2000);
    if (!error && data) {
      const map: Record<string, MetricsRow> = {};
      for (const r of data as (MetricsRow & { agents: unknown })[]) {
        if (!map[r.agent_id]) {
          map[r.agent_id] = {
            agent_id: r.agent_id,
            cpu_usage: r.cpu_usage,
            ram_usage: r.ram_usage,
            disk_usage: r.disk_usage,
            battery_level: r.battery_level,
            network_speed: r.network_speed,
            recorded_at: r.recorded_at,
          };
        }
      }
      setByAgent(map);
    }
    setLoading(false);
  }, [organization]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  return { byAgent, loading, refresh };
}

// =============== Server-side aggregation (RPCs) ===============
//
// These bypass the per-row download path; the SQL functions live in
// supabase/migrations/0007_aggregation.sql. Use these instead of useActivityLogs whenever you only
// need totals/buckets — much faster and pagination-proof at scale.

export type OrgProductivityStats = {
  total_active_seconds: number;
  total_weighted_seconds: number;
  total_idle_seconds: number;
  total_screenshots: number;
  pending_alerts: number;
  online_agents: number;
  // Derived in JS so callers don't repeat the math.
  productivity_pct: number | null;
};

export function useOrgProductivityStats(sinceHours: number) {
  const { organization } = useAuth();
  const [stats, setStats] = useState<OrgProductivityStats | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organization) {
      setStats(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const { data, error } = await supabase.rpc('org_productivity_stats', {
      p_org_id: organization.id,
      p_since: since,
    });
    if (!error && data && data.length > 0) {
      const r = data[0] as Omit<OrgProductivityStats, 'productivity_pct'>;
      const active = Number(r.total_active_seconds) || 0;
      const weighted = Number(r.total_weighted_seconds) || 0;
      setStats({
        total_active_seconds: active,
        total_weighted_seconds: weighted,
        total_idle_seconds: Number(r.total_idle_seconds) || 0,
        total_screenshots: Number(r.total_screenshots) || 0,
        pending_alerts: Number(r.pending_alerts) || 0,
        online_agents: Number(r.online_agents) || 0,
        productivity_pct: active > 0 ? Math.round((weighted / active) * 100) : null,
      });
    } else {
      setStats(null);
    }
    setLoading(false);
  }, [organization, sinceHours]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { stats, loading, refresh };
}

export type DailyProductivityRow = {
  day_bucket: string;
  active_seconds: number;
  weighted_seconds: number;
  active_agents: number;
  productivity_pct: number;
};

export function useOrgProductivityDaily(days: number) {
  const { organization } = useAuth();
  const [rows, setRows] = useState<DailyProductivityRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organization) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase.rpc('org_productivity_daily', {
      p_org_id: organization.id,
      p_days: days,
    });
    if (!error && data) {
      type Raw = {
        day_bucket: string;
        active_seconds: number | string;
        weighted_seconds: number | string;
        active_agents: number | string;
      };
      setRows(
        (data as Raw[]).map((r) => {
          const active = Number(r.active_seconds) || 0;
          const weighted = Number(r.weighted_seconds) || 0;
          return {
            day_bucket: r.day_bucket,
            active_seconds: active,
            weighted_seconds: weighted,
            active_agents: Number(r.active_agents) || 0,
            productivity_pct: active > 0 ? Math.round((weighted / active) * 100) : 0,
          };
        }),
      );
    }
    setLoading(false);
  }, [organization, days]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { rows, loading, refresh };
}

export type PerAgentAgg = {
  agent_id: string;
  active_seconds: number;
  weighted_seconds: number;
  idle_seconds: number;
  app_switches: number;
  browser_events: number;
  screenshots: number;
  alerts_count: number;
  productivity_pct: number;
};

export function useProductivityPerAgent(sinceHours: number) {
  const { organization } = useAuth();
  const [byAgent, setByAgent] = useState<Record<string, PerAgentAgg>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organization) {
      setByAgent({});
      setLoading(false);
      return;
    }
    setLoading(true);
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const { data, error } = await supabase.rpc('org_productivity_per_agent', {
      p_org_id: organization.id,
      p_since: since,
    });
    if (!error && data) {
      type Raw = Omit<PerAgentAgg, 'productivity_pct'>;
      const map: Record<string, PerAgentAgg> = {};
      for (const r of data as Raw[]) {
        const active = Number(r.active_seconds) || 0;
        const weighted = Number(r.weighted_seconds) || 0;
        map[r.agent_id] = {
          agent_id: r.agent_id,
          active_seconds: active,
          weighted_seconds: weighted,
          idle_seconds: Number(r.idle_seconds) || 0,
          app_switches: Number(r.app_switches) || 0,
          browser_events: Number(r.browser_events) || 0,
          screenshots: Number(r.screenshots) || 0,
          alerts_count: Number(r.alerts_count) || 0,
          productivity_pct: active > 0 ? Math.round((weighted / active) * 100) : 0,
        };
      }
      setByAgent(map);
    }
    setLoading(false);
  }, [organization, sinceHours]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { byAgent, loading, refresh };
}

// Generates short-lived signed URLs for storage paths in one batch.
function useSignedUrls(bucket: string, paths: string[], ttlSeconds: number) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const missing = paths.filter((p) => p && !urls[p]);
    if (missing.length === 0) return;
    (async () => {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrls(missing, ttlSeconds);
      if (cancelled || error || !data) return;
      const next: Record<string, string> = { ...urls };
      for (const item of data) {
        if (item.path && item.signedUrl) next[item.path] = item.signedUrl;
      }
      setUrls(next);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join('|')]);

  return urls;
}

export function useSignedScreenshotUrls(paths: string[], ttlSeconds = 3600) {
  return useSignedUrls('screenshots', paths, ttlSeconds);
}

export function useSignedVideoUrls(paths: string[], ttlSeconds = 3600) {
  return useSignedUrls('videos', paths, ttlSeconds);
}

export function useTrialDaysLeft(): number | null {
  const { organization } = useAuth();
  if (!organization) return null;
  const ms = new Date(organization.trial_ends_at).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}
