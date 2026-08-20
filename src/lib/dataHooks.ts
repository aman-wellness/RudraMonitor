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
  /** Enrollment timestamp — drives the "fleet growth" sparkline on the dashboard. */
  createdAt: string;
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
  /** Capture cadence from the agent's own row — seconds, or null if unset. */
  idleThresholdSecs: number | null;
  screenshotIntervalSecs: number | null;
  videoIntervalSecs: number | null;
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
  createdAt: a.created_at,
  ipAddress: a.ip_address ?? '-',
  department: a.department ?? DEFAULT_DEPT,
  productivity: 0,
  activeHours: '0h 0m',
  idleTime: '0m',
  applications: [],
  browserUrls: [],
  enrollToken: a.enroll_token,
  idleThresholdSecs: a.idle_threshold_secs ?? null,
  screenshotIntervalSecs: a.screenshot_interval_secs ?? null,
  videoIntervalSecs: a.video_interval_secs ?? null,
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

  /**
   * Make sure a department name exists in org_departments.
   *
   * The agents page lets an admin type a brand-new department into the
   * per-agent dropdown. That used to write only agents.department — free text
   * with no foreign key — so the department worked everywhere that reads the
   * agent row (listings, filters, reports) but never appeared in Admin Portal →
   * Departments, which reads org_departments. It also meant
   * org_departments.agent_count stayed 0 for it, so the "N agents assigned"
   * warning shown before deleting a department could not fire for exactly the
   * departments most likely to be in use.
   *
   * Best-effort: a failure here must not block the assignment itself, which is
   * the thing the admin actually asked for. Idempotent — ON CONFLICT DO NOTHING
   * against the (org_id, name) unique key.
   */
  const ensureDepartment = async (name: string) => {
    if (!organization) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const { error } = await supabase
      .from('org_departments')
      .upsert({ org_id: organization.id, name: trimmed }, { onConflict: 'org_id,name', ignoreDuplicates: true });
    if (error) console.error('ensureDepartment', trimmed, error.message);
  };

  const updateDepartment = async (agentId: string, agentDepartment: string) => {
    if (!organization) return;
    const prev = agents;
    setAgents((p) => p.map((a) => (a.id === agentId ? { ...a, department: agentDepartment } : a)));

    // BEFORE the agent update, not after. trg_agents_dept_count fires on the
    // agents write and calls refresh_dept_agent_count(org, dept), which can
    // only update an org_departments row that already exists. Creating the
    // department afterwards would leave it at its default agent_count of 0
    // until some unrelated change to that agent happened to fire the trigger
    // again.
    await ensureDepartment(agentDepartment);

    // Defense-in-depth: RLS already scopes by org, but adding org_id to the
    // filter makes a cross-org mutation impossible even if RLS misconfigures.
    const { error } = await supabase
      .from('agents')
      .update({ department: agentDepartment })
      .eq('id', agentId)
      .eq('org_id', organization.id);
    if (error) {
      setAgents(prev);
      setError(error.message);
    }
  };

  const createAgent = async (input: { agentName: string; machineName?: string; osType?: string; department?: string }) => {
    if (!organization) throw new Error('No organization loaded');
    // Same reason and same ordering as updateDepartment: the department has to
    // exist before the agents row is written, or the count trigger has nothing
    // to update.
    if (input.department) await ensureDepartment(input.department);
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
  /** Reporting agent's department, needed to resolve department-scoped rules. */
  agent_department: string | null;
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
  /** Hours before now the window ENDS. 0 = up to now. Lets a caller ask for a
   *  historical range rather than only "the last N hours". */
  untilHours?: number;
  limit?: number;            // default 500
};

export function useActivityLogs(filter: ActivityFilter = {}) {
  const { organization } = useAuth();
  const [rows, setRows] = useState<ActivityLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sinceHours = filter.sinceHours ?? 24;
  const untilHours = filter.untilHours ?? 0;
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
      .select('id, agent_id, activity_type, application_name, url, duration, screenshot_url, video_url, created_at, agents!inner(agent_name, department, org_id)')
      .gte('created_at', since)
      .eq('agents.org_id', organization.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (untilHours > 0) {
      q = q.lte('created_at', new Date(Date.now() - untilHours * 3600 * 1000).toISOString());
    }
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
        agents: { agent_name: string; department: string | null } | { agent_name: string; department: string | null }[];
      };
      const mapped: ActivityLogRow[] = (data as Joined[]).map((r) => ({
        id: r.id,
        agent_id: r.agent_id,
        agent_name: Array.isArray(r.agents) ? (r.agents[0]?.agent_name ?? '') : r.agents?.agent_name ?? '',
        agent_department: Array.isArray(r.agents) ? (r.agents[0]?.department ?? null) : r.agents?.department ?? null,
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
  }, [organization, type, agentId, sinceHours, untilHours, limit]);

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
  // NULL = inherit org default (= every paid feature). Empty array = no
  // feature access (login-only). Owners + admins ignore this column.
  app_access: string[] | null;
  // Per-feature level. NULL = "full" on every code in app_access.
  // Otherwise { code: 'view'|'edit'|'full' }. Keys must be a subset of
  // app_access; Admin Portal UI keeps them in sync.
  app_access_levels: Record<string, 'view' | 'edit' | 'full'> | null;
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
      .select('id, user_id, org_id, role, full_name, email, created_at, app_access, app_access_levels')
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
  const inviteMember = async (input: {
    email: string;
    role: 'admin' | 'viewer';
    full_name?: string;
    app_access?: string[] | null;
    app_access_levels?: Record<string, 'view' | 'edit' | 'full'> | null;
  }) => {
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

  // Re-send the magic-link invite for a pending user. No-op if the user
  // has already accepted (server returns 409 → surfaced as an error).
  const resendInvite = async (email: string) => {
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
      body: JSON.stringify({ email, resend: true }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error ?? `resend failed (${resp.status})`);
    }
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

  return { members, loading, refresh, inviteMember, resendInvite, removeMember };
}

// =============== Aggregated application usage ===============

export type AppUsageRow = {
  agent_id: string;
  agent_name: string;
  department: string | null;
  application_name: string;
  window_title: string | null;
  total_seconds: number;
  events: number;
  last_seen: string;
};

/**
 * Per (agent, application) foreground time for a window, aggregated in SQL.
 *
 * Replaces fetching raw activity_logs and grouping client-side. That approach
 * applied its row limit BEFORE grouping, so one busy application could consume
 * the whole page and hide every other app the employee used — and each
 * surviving app's duration was only the part of it that fitted in the window.
 * See migration 0130 for the measurements.
 */
export function useAppUsage(filter: { agentId?: string; sinceHours?: number } = {}) {
  const { organization } = useAuth();
  const [rows, setRows] = useState<AppUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sinceHours = filter.sinceHours ?? 24;
  const agentId = filter.agentId;

  const refresh = useCallback(async () => {
    if (!organization) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error: err } = await supabase.rpc('org_app_usage', {
      p_org_id: organization.id,
      p_since: new Date(Date.now() - sinceHours * 3600 * 1000).toISOString(),
      p_agent_id: agentId && agentId !== 'all' ? agentId : null,
    });
    if (err) setError(err.message);
    else setError(null);
    setRows((data as AppUsageRow[]) ?? []);
    setLoading(false);
  }, [organization, sinceHours, agentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { rows, loading, error, refresh };
}

// =============== Aggregated browsing ===============

export type BrowserUsageRow = {
  agent_id: string;
  agent_name: string;
  department: string | null;
  host: string;
  page_title: string | null;
  last_url: string | null;
  total_seconds: number;
  visits: number;
  last_visit: string;
  unresolved_samples: number;
  unresolved_seconds: number;
};

/**
 * Per (agent, host) browsing time, aggregated in SQL — see migration 0131.
 *
 * Fixes three things the client-side version got wrong: the row limit truncated
 * the list before grouping, activity_logs.page_title was never fetched so the
 * raw URL was displayed instead of the page title, and samples with no readable
 * address bar collapsed into one unnamed group that outranked every real site.
 */
export function useBrowserUsage(filter: { agentId?: string; sinceHours?: number } = {}) {
  const { organization } = useAuth();
  const [rows, setRows] = useState<BrowserUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sinceHours = filter.sinceHours ?? 24;
  const agentId = filter.agentId;

  const refresh = useCallback(async () => {
    if (!organization) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error: err } = await supabase.rpc('org_browser_usage', {
      p_org_id: organization.id,
      p_since: new Date(Date.now() - sinceHours * 3600 * 1000).toISOString(),
      p_agent_id: agentId && agentId !== 'all' ? agentId : null,
    });
    if (err) setError(err.message);
    else setError(null);
    setRows((data as BrowserUsageRow[]) ?? []);
    setLoading(false);
  }, [organization, sinceHours, agentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { rows, loading, error, refresh };
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
  /** null = organisation-wide default, applying to every department. */
  department: string | null;
};

// Lookup table for O(1) classification. The key includes the department scope
// because a pattern can carry both an organisation-wide default and a
// department override — keying on (match_type, pattern) alone made the two
// collide, and whichever row the query happened to return last silently won.
export type RuleMap = Record<string, Category>;

export const ruleKey = (matchType: MatchType, pattern: string, department?: string | null) =>
  `${(department ?? '').trim().toLowerCase()}|${matchType}:${pattern.toLowerCase()}`;

/**
 * Candidate patterns for a subject, most specific first.
 *
 * Hosts also match by SUFFIX, so one rule per registrable domain covers its
 * subdomains — `github.com` classifies `gist.github.com`. Without this, a rule
 * catalogue would classify almost nothing, because real browsing is mostly
 * subdomains (`console.firebase.google.com`,
 * `eu-north-1.console.aws.amazon.com`). Applications are matched exactly; a
 * process name has no hierarchy to walk.
 *
 * Longest first, so an explicit `docs.google.com` rule beats a general
 * `google.com` one — the same ordering the RPC applies with
 * `ORDER BY length(pattern) DESC`.
 */
const candidatePatterns = (matchType: MatchType, subject: string): string[] => {
  const s = subject.trim().toLowerCase();
  if (matchType !== 'host') return [s];
  const labels = s.split('.');
  const out: string[] = [];
  // Stop at two labels: a bare TLD is never a meaningful rule.
  for (let i = 0; i + 2 <= labels.length; i++) out.push(labels.slice(i).join('.'));
  return out.length ? out : [s];
};

/**
 * Effective category for a subject, from the point of view of one department.
 *
 * Precedence mirrors the LEFT JOIN LATERAL in the org_productivity_* RPCs
 * exactly: EVERY department-scoped match outranks EVERY organisation-wide one,
 * and within a scope the most specific pattern wins. Note the ordering — a
 * department rule for `google.com` beats an org-wide rule for
 * `docs.google.com`, because the RPC sorts by `(department IS NULL)` before
 * `length(pattern)`. If the two implementations disagreed, the dashboard would
 * show one category and the productivity figure would be computed from another.
 *
 * Falls back to 'unproductive', not 'neutral': anything not in the catalogue
 * does not count as work (see migration 0134). 'neutral' remains reachable only
 * as an explicit rule, and is excluded from the ratio entirely.
 */
export const classify = (
  rules: RuleMap,
  matchType: MatchType,
  pattern: string,
  department?: string | null,
): Category => {
  const candidates = candidatePatterns(matchType, pattern);
  for (const scope of department ? [department, null] : [null]) {
    for (const c of candidates) {
      const hit = rules[ruleKey(matchType, c, scope)];
      if (hit) return hit;
    }
  }
  return 'unproductive';
};

/** True when a department override — not the org-wide default — is deciding this row. */
export const isDepartmentOverridden = (
  rules: RuleMap,
  matchType: MatchType,
  pattern: string,
  department?: string | null,
): boolean => {
  if (!department) return false;
  return candidatePatterns(matchType, pattern)
    .some((c) => rules[ruleKey(matchType, c, department)] !== undefined);
};

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
    for (const r of rules) m[ruleKey(r.match_type, r.pattern, r.department)] = r.category;
    return m;
  }, [rules]);

  const upsertRule = async (matchType: MatchType, pattern: string, category: Category) => {
    if (!organization) return;
    const trimmed = pattern.trim();
    if (!trimmed) return;
    // The inline classifier in Live monitoring writes the ORGANISATION-WIDE
    // default (department null), which is what it has always done. Department
    // overrides are managed in Admin Portal → Applications, so a quick
    // reclassification here can never narrow a rule to one team by accident.
    setRules((prev) => {
      const others = prev.filter((r) => !(
        r.match_type === matchType
        && r.pattern.toLowerCase() === trimmed.toLowerCase()
        && r.department === null
      ));
      return [
        ...others,
        { id: 'temp', org_id: organization.id, match_type: matchType, pattern: trimmed, category, department: null },
      ];
    });
    const { error } = await supabase
      .from('productivity_rules')
      .upsert(
        { org_id: organization.id, match_type: matchType, pattern: trimmed, category, department: null },
        // Must name the CURRENT unique key. This was
        // 'org_id,match_type,pattern' until department was added; that
        // constraint no longer exists, so leaving it would have made every
        // inline reclassification fail.
        { onConflict: 'org_id,match_type,pattern,department' },
      );
    if (error) {
      void refresh();
      throw error;
    }
    void refresh();
  };

  // Deletes the ORGANISATION-WIDE default only, mirroring upsertRule. Without
  // the department filter this removed every scope for the pattern, so
  // clearing a default from Live monitoring would also silently destroy every
  // department override an admin had configured for it.
  const deleteRule = async (matchType: MatchType, pattern: string) => {
    if (!organization) return;
    const prev = rules;
    setRules((p) => p.filter((r) => !(
      r.match_type === matchType
      && r.pattern.toLowerCase() === pattern.toLowerCase()
      && r.department === null
    )));
    const { error } = await supabase
      .from('productivity_rules')
      .delete()
      .eq('org_id', organization.id)
      .eq('match_type', matchType)
      .eq('pattern', pattern)
      .is('department', null);
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
  /** Free text written by the agent — high_cpu, unauthorized_usb,
   *  idle_extended, offline, … NOT an error/warning/info severity enum. It was
   *  typed as that union, which is why several screens branch on 'error' /
   *  'warning' and always fall through to the neutral case. */
  alert_type: string;
  message: string;
  ai_resolved: boolean;
  resolution: string | null;
  created_at: string;
};

export function useAlerts(
  opts: { sinceHours?: number; untilHours?: number; agentId?: string | null; limit?: number } = {},
) {
  const { organization } = useAuth();
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);

  const sinceHours = opts.sinceHours ?? 24 * 7;
  const untilHours = opts.untilHours ?? 0;
  const agentId = opts.agentId ?? null;
  const limit = opts.limit ?? 200;

  const refresh = useCallback(async () => {
    if (!organization) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const until = new Date(Date.now() - untilHours * 3600 * 1000).toISOString();
    let q = supabase
      .from('alerts')
      .select('id, agent_id, alert_type, message, ai_resolved, resolution, created_at, agents!inner(agent_name, org_id)')
      .gte('created_at', since)
      .lte('created_at', until)
      .eq('agents.org_id', organization.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (agentId) q = q.eq('agent_id', agentId);
    const { data, error } = await q;
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
  }, [organization, sinceHours, untilHours, agentId, limit]);

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

  /**
   * Resolve several alerts in one round trip.
   *
   * Not a loop over resolveAlert: triaging a noisy day can mean hundreds of
   * rows, and that would be hundreds of sequential requests with a partially
   * applied result if one failed halfway. A single `in` filter either applies to
   * all of them or to none.
   */
  const resolveAlerts = async (alertIds: string[], resolution: string) => {
    if (alertIds.length === 0) return 0;
    const ids = new Set(alertIds);
    const prev = rows;
    setRows((p) => p.map((a) => (ids.has(a.id) ? { ...a, ai_resolved: true, resolution } : a)));
    const { error } = await supabase
      .from('alerts')
      .update({ ai_resolved: true, resolution })
      .in('id', alertIds);
    if (error) {
      setRows(prev);
      throw error;
    }
    return alertIds.length;
  };

  return { rows, loading, refresh, resolveAlert, resolveAlerts };
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

// Mirrors the column names org_productivity_stats actually returns as of
// migration 0118. It used to return total_*/pending_alerts/online_agents;
// 0118 renamed them and dropped the last two, which silently turned every
// field here into NaN → the dashboard showed "—" productivity and 0 alerts
// even with a day of activity in the table. Callers that need unresolved
// alert counts or the online agent count read useAlerts / useAgents instead.
export type OrgProductivityStats = {
  total_active_seconds: number;
  total_weighted_seconds: number;
  total_idle_seconds: number;
  total_screenshots: number;
  app_switches: number;
  browser_events: number;
  /** All alerts raised in the window (not just unresolved ones). */
  alerts_count: number;
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
      type Raw = {
        active_seconds: number | string;
        weighted_seconds: number | string;
        idle_seconds: number | string;
        app_switches: number | string;
        browser_events: number | string;
        screenshots: number | string;
        alerts_count: number | string;
      };
      const r = data[0] as Raw;
      const active = Number(r.active_seconds) || 0;
      // weighted_seconds is 'productive_seconds' since 0118 — time that
      // matched a productivity_rule with category 'productive'.
      const weighted = Number(r.weighted_seconds) || 0;
      setStats({
        total_active_seconds: active,
        total_weighted_seconds: weighted,
        total_idle_seconds: Number(r.idle_seconds) || 0,
        total_screenshots: Number(r.screenshots) || 0,
        app_switches: Number(r.app_switches) || 0,
        browser_events: Number(r.browser_events) || 0,
        alerts_count: Number(r.alerts_count) || 0,
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

/** `untilHours` shifts the window's END back from now, `agentId` scopes it to
 *  one machine — both pushed down to the RPC (migration 0126). */
export function useOrgProductivityDaily(days: number, untilHours = 0, agentId?: string | null) {
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
      p_until: new Date(Date.now() - untilHours * 3600 * 1000).toISOString(),
      p_agent_id: agentId ?? null,
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
  }, [organization, days, untilHours, agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { rows, loading, refresh };
}

export type PerAgentAgg = {
  agent_id: string;
  active_seconds: number;
  weighted_seconds: number;
  /** Rule-matched 'unproductive' time. active - weighted - unproductive = neutral
   *  (time on apps no productivity_rule covers). The dashboard donut needs all
   *  three buckets, so this is surfaced rather than folded into the pct. */
  unproductive_seconds: number;
  idle_seconds: number;
  app_switches: number;
  browser_events: number;
  screenshots: number;
  alerts_count: number;
  productivity_pct: number;
};

export function useProductivityPerAgent(sinceHours: number, untilHours = 0) {
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
    const until = new Date(Date.now() - untilHours * 3600 * 1000).toISOString();
    const { data, error } = await supabase.rpc('org_productivity_per_agent', {
      p_org_id: organization.id,
      p_since: since,
      p_until: until,
    });
    if (!error && data) {
      type Raw = Omit<PerAgentAgg, 'productivity_pct'> & { unproductive_seconds?: number | string };
      const map: Record<string, PerAgentAgg> = {};
      for (const r of data as Raw[]) {
        const active = Number(r.active_seconds) || 0;
        // weighted_seconds is now `productive_seconds` (migration 0118).
        // The 0.5 neutral-fallback that used to pin every agent at 50%
        // is gone — an app has to match an explicit 'productive' rule
        // to contribute here.
        const productive = Number(r.weighted_seconds) || 0;
        const unproductive = Number(r.unproductive_seconds ?? 0) || 0;
        const categorized = productive + unproductive;
        // productivity_pct semantics:
        //   categorized > 0 → productive share of rule-matched time
        //   categorized = 0 → 0 (no productivity_rules match anything,
        //                        so productivity is undefined; UI can
        //                        interpret 0 with 0 categorized as
        //                        "N/A" and render "—" if it wants).
        // Reason we don't emit a real `null`: dashboard call sites
        // currently type this as `number`; changing to `number | null`
        // ripples through downstream components. Callers that want
        // "N/A" detection should check `weighted_seconds === 0 &&
        // unproductive_seconds === 0` explicitly.
        map[r.agent_id] = {
          agent_id: r.agent_id,
          active_seconds: active,
          weighted_seconds: productive,
          unproductive_seconds: unproductive,
          idle_seconds: Number(r.idle_seconds) || 0,
          app_switches: Number(r.app_switches) || 0,
          browser_events: Number(r.browser_events) || 0,
          screenshots: Number(r.screenshots) || 0,
          alerts_count: Number(r.alerts_count) || 0,
          productivity_pct: categorized > 0
            ? Math.round((productive / categorized) * 100)
            : 0,
        };
      }
      setByAgent(map);
    }
    setLoading(false);
  }, [organization, sinceHours, untilHours]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { byAgent, loading, refresh };
}

// =============== Dashboard aggregates (migration 0125) ===============
//
// Both hooks prefer the server-side RPC and fall back to client-side
// bucketing over a capped window when the function isn't deployed yet.
// The fallback flags itself via `approximate` so the UI can say so instead
// of quietly showing a truncated total.

const FALLBACK_ROW_CAP = 5000;

export type HourlyActivityRow = {
  /** ISO timestamp of the bucket start (local hour). */
  hour: string;
  activeSeconds: number;
  activeAgents: number;
};

export function useOrgActivityHourly(hours: number, untilHours = 0, agentId?: string | null) {
  const { organization } = useAuth();
  const [rows, setRows] = useState<HourlyActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [approximate, setApproximate] = useState(false);

  const refresh = useCallback(async () => {
    if (!organization) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const until = new Date(Date.now() - untilHours * 3600 * 1000);
    const { data, error } = await supabase.rpc('org_activity_hourly', {
      p_org_id: organization.id,
      p_hours: hours,
      p_until: until.toISOString(),
      p_agent_id: agentId ?? null,
    });
    if (!error && data) {
      type Raw = { hour_bucket: string; active_seconds: number | string; active_agents: number | string };
      setRows((data as Raw[]).map((r) => ({
        hour: r.hour_bucket,
        activeSeconds: Number(r.active_seconds) || 0,
        activeAgents: Number(r.active_agents) || 0,
      })));
      setApproximate(false);
      setLoading(false);
      return;
    }

    // Fallback: bucket client-side. Only reached before 0125/0126 are applied.
    const since = new Date(until.getTime() - (hours - 1) * 3600 * 1000);
    let fq = supabase
      .from('activity_logs')
      .select('agent_id, activity_type, duration, created_at, agents!inner(org_id)')
      .gte('created_at', since.toISOString())
      .lte('created_at', until.toISOString())
      .eq('agents.org_id', organization.id)
      .in('activity_type', ['app', 'browser'])
      .order('created_at', { ascending: false })
      .limit(FALLBACK_ROW_CAP);
    if (agentId) fq = fq.eq('agent_id', agentId);
    const { data: logs } = await fq;
    const seconds = new Map<number, number>();
    const agentsSeen = new Map<number, Set<string>>();
    for (const r of (logs ?? []) as { agent_id: string; duration: number | null; created_at: string }[]) {
      const t = new Date(r.created_at);
      t.setMinutes(0, 0, 0);
      const key = t.getTime();
      seconds.set(key, (seconds.get(key) ?? 0) + Math.max(0, r.duration ?? 0));
      const set = agentsSeen.get(key) ?? new Set<string>();
      set.add(r.agent_id);
      agentsSeen.set(key, set);
    }
    // Gap-fill so the chart x-axis stays continuous, matching the RPC.
    const end = new Date(until);
    end.setMinutes(0, 0, 0);
    const out: HourlyActivityRow[] = [];
    for (let i = hours - 1; i >= 0; i--) {
      const t = new Date(end.getTime() - i * 3600 * 1000);
      const key = t.getTime();
      out.push({
        hour: t.toISOString(),
        activeSeconds: seconds.get(key) ?? 0,
        activeAgents: agentsSeen.get(key)?.size ?? 0,
      });
    }
    setRows(out);
    setApproximate((logs?.length ?? 0) >= FALLBACK_ROW_CAP);
    setLoading(false);
  }, [organization, hours, untilHours, agentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { rows, loading, approximate, refresh };
}

export type TopAppRow = { name: string; seconds: number; events: number };

export function useTopApplications(
  sinceHours: number,
  limit = 6,
  untilHours = 0,
  agentId?: string | null,
) {
  const { organization } = useAuth();
  const [rows, setRows] = useState<TopAppRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [approximate, setApproximate] = useState(false);

  const refresh = useCallback(async () => {
    if (!organization) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
    const until = new Date(Date.now() - untilHours * 3600 * 1000).toISOString();
    const { data, error } = await supabase.rpc('org_top_applications', {
      p_org_id: organization.id,
      p_since: since,
      p_limit: limit,
      p_until: until,
      p_agent_id: agentId ?? null,
    });
    if (!error && data) {
      type Raw = { app_name: string; seconds: number | string; events: number | string };
      setRows((data as Raw[]).map((r) => ({
        name: r.app_name,
        seconds: Number(r.seconds) || 0,
        events: Number(r.events) || 0,
      })));
      setApproximate(false);
      setLoading(false);
      return;
    }

    // Fallback: aggregate client-side over a capped window.
    let fq = supabase
      .from('activity_logs')
      .select('application_name, duration, agents!inner(org_id)')
      .gte('created_at', since)
      .lte('created_at', until)
      .eq('agents.org_id', organization.id)
      .eq('activity_type', 'app')
      .order('created_at', { ascending: false })
      .limit(FALLBACK_ROW_CAP);
    if (agentId) fq = fq.eq('agent_id', agentId);
    const { data: logs } = await fq;
    const totals = new Map<string, { seconds: number; events: number }>();
    for (const r of (logs ?? []) as { application_name: string | null; duration: number | null }[]) {
      const name = (r.application_name ?? '').trim();
      if (!name) continue;
      const cur = totals.get(name) ?? { seconds: 0, events: 0 };
      cur.seconds += Math.max(0, r.duration ?? 0);
      cur.events += 1;
      totals.set(name, cur);
    }
    setRows(
      [...totals.entries()]
        .map(([name, v]) => ({ name, seconds: v.seconds, events: v.events }))
        .sort((a, b) => b.seconds - a.seconds || b.events - a.events)
        .slice(0, limit),
    );
    setApproximate((logs?.length ?? 0) >= FALLBACK_ROW_CAP);
    setLoading(false);
  }, [organization, sinceHours, untilHours, agentId, limit]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { rows, loading, approximate, refresh };
}

/** agent_id → { hourStartMs → activeSeconds }. Drives the per-agent presence
 *  strips in the dashboard agent table. */
export function useAgentActivityHourly(hours: number, untilHours = 0, agentId?: string | null) {
  const { organization } = useAuth();
  const [byAgent, setByAgent] = useState<Record<string, Record<number, number>>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organization) {
      setByAgent({});
      setLoading(false);
      return;
    }
    setLoading(true);
    const until = new Date(Date.now() - untilHours * 3600 * 1000);
    const { data, error } = await supabase.rpc('org_agent_hourly', {
      p_org_id: organization.id,
      p_hours: hours,
      p_until: until.toISOString(),
      p_agent_id: agentId ?? null,
    });
    const out: Record<string, Record<number, number>> = {};
    if (!error && data) {
      for (const r of data as { agent_id: string; hour_bucket: string; active_seconds: number | string }[]) {
        const bucket = new Date(r.hour_bucket);
        bucket.setMinutes(0, 0, 0);
        const map = out[r.agent_id] ?? (out[r.agent_id] = {});
        map[bucket.getTime()] = (map[bucket.getTime()] ?? 0) + (Number(r.active_seconds) || 0);
      }
    } else {
      // Fallback before 0125/0126: bucket a capped window client-side.
      const since = new Date(until.getTime() - (hours - 1) * 3600 * 1000).toISOString();
      let fq = supabase
        .from('activity_logs')
        .select('agent_id, duration, created_at, agents!inner(org_id)')
        .gte('created_at', since)
        .lte('created_at', until.toISOString())
        .eq('agents.org_id', organization.id)
        .in('activity_type', ['app', 'browser'])
        .order('created_at', { ascending: false })
        .limit(FALLBACK_ROW_CAP);
      if (agentId) fq = fq.eq('agent_id', agentId);
      const { data: logs } = await fq;
      for (const r of (logs ?? []) as { agent_id: string; duration: number | null; created_at: string }[]) {
        const t = new Date(r.created_at);
        t.setMinutes(0, 0, 0);
        const map = out[r.agent_id] ?? (out[r.agent_id] = {});
        map[t.getTime()] = (map[t.getTime()] ?? 0) + Math.max(0, r.duration ?? 0);
      }
    }
    setByAgent(out);
    setLoading(false);
  }, [organization, hours, untilHours, agentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { byAgent, loading, refresh };
}

// =============== DLP risk summary ===============

export type DlpRiskEvent = {
  id: string;
  agent_name: string;
  event_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical' | null;
  authorized: boolean | null;
  file_name: string | null;
  occurred_at: string;
};

/** Severity counts for the window plus the same counts for the preceding
 *  window, so the dashboard can show a real trend instead of a bare number. */
export function useDlpRisk(sinceHours: number, untilHours = 0, agentId?: string | null) {
  const { organization } = useAuth();
  const [events, setEvents] = useState<DlpRiskEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organization) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    // Pull two windows in one query; split client-side.
    // Two windows deep, so the trend has a baseline to compare against.
    const until = new Date(Date.now() - untilHours * 3600 * 1000);
    const since = new Date(until.getTime() - sinceHours * 2 * 3600 * 1000).toISOString();
    let q = supabase
      .from('dlp_events')
      .select('id, event_type, ai_severity, ai_authorized, file_name, occurred_at, agents(agent_name)')
      .eq('org_id', organization.id)
      .gte('occurred_at', since)
      .lte('occurred_at', until.toISOString())
      .order('occurred_at', { ascending: false })
      .limit(500);
    if (agentId) q = q.eq('agent_id', agentId);
    const { data } = await q;
    type Raw = {
      id: string;
      event_type: string;
      ai_severity: DlpRiskEvent['severity'];
      ai_authorized: boolean | null;
      file_name: string | null;
      occurred_at: string;
      agents: { agent_name: string } | { agent_name: string }[] | null;
    };
    setEvents(
      ((data ?? []) as Raw[]).map((r) => ({
        id: r.id,
        agent_name: Array.isArray(r.agents) ? (r.agents[0]?.agent_name ?? '') : (r.agents?.agent_name ?? ''),
        event_type: r.event_type,
        severity: r.ai_severity,
        authorized: r.ai_authorized,
        file_name: r.file_name,
        occurred_at: r.occurred_at,
      })),
    );
    setLoading(false);
  }, [organization, sinceHours, untilHours, agentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const summary = useMemo(() => {
    const cutoff = Date.now() - (untilHours + sinceHours) * 3600 * 1000;
    const counts = { low: 0, medium: 0, high: 0, critical: 0, unclassified: 0 };
    let current = 0;
    let previous = 0;
    // Tracked separately per window so a caller showing the high+critical count
    // can trend it against the same measure, rather than against total volume.
    let serious = 0;
    let seriousPrevious = 0;
    for (const e of events) {
      const t = new Date(e.occurred_at).getTime();
      const isSerious = e.severity === 'high' || e.severity === 'critical';
      if (t >= cutoff) {
        current += 1;
        if (isSerious) serious += 1;
        if (e.severity) counts[e.severity] += 1;
        else counts.unclassified += 1;
      } else {
        previous += 1;
        if (isSerious) seriousPrevious += 1;
      }
    }
    return { counts, current, previous, serious, seriousPrevious };
  }, [events, sinceHours, untilHours]);

  const recent = useMemo(() => {
    const cutoff = Date.now() - (untilHours + sinceHours) * 3600 * 1000;
    return events.filter((e) => new Date(e.occurred_at).getTime() >= cutoff);
  }, [events, sinceHours, untilHours]);

  return { events: recent, summary, loading, refresh };
}

// =============== Configured working hours ===============

/** Per weekday (0 = Sunday … 6 = Saturday), the set of hours that count as
 *  working time for this org. */
export type WorkHours = {
  /** byDay[dow] = Set of hour numbers 0-23 that are inside working hours. */
  byDay: Set<number>[];
  /** False when the org hasn't configured a schedule and we're using the
   *  Mon–Fri 9-6 fallback — the UI says so rather than implying it's theirs. */
  configured: boolean;
  loading: boolean;
};

const FALLBACK_START = 9;
const FALLBACK_END = 18; // exclusive
const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const fallbackByDay = () =>
  DOW_KEYS.map((_, dow) => {
    const s = new Set<number>();
    if (dow >= 1 && dow <= 5) for (let h = FALLBACK_START; h < FALLBACK_END; h++) s.add(h);
    return s;
  });

/**
 * Reads organization_settings.tracking_schedule_json (migration 0115) — the
 * same schedule the agents use to decide when to capture — so "after hours"
 * on the dashboard means after *this org's* hours, not a hardcoded 9-to-6.
 * Falls back to Mon–Fri 09:00–18:00 when no schedule is enabled.
 */
export function useOrgWorkHours(): WorkHours {
  const { organization } = useAuth();
  const [state, setState] = useState<{ byDay: Set<number>[]; configured: boolean; loading: boolean }>(
    { byDay: fallbackByDay(), configured: false, loading: true },
  );

  useEffect(() => {
    if (!organization) {
      setState({ byDay: fallbackByDay(), configured: false, loading: false });
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('organization_settings')
        .select('tracking_schedule_enabled, tracking_schedule_json')
        .eq('org_id', organization.id)
        .maybeSingle();
      if (cancelled) return;

      const row = data as
        | { tracking_schedule_enabled: boolean | null; tracking_schedule_json: string | null }
        | null;
      if (!row?.tracking_schedule_enabled || !row.tracking_schedule_json) {
        setState({ byDay: fallbackByDay(), configured: false, loading: false });
        return;
      }
      try {
        const parsed = JSON.parse(row.tracking_schedule_json) as {
          days?: Record<string, { start: string; end: string }[]>;
        };
        const byDay = DOW_KEYS.map((key) => {
          const set = new Set<number>();
          for (const range of parsed.days?.[key] ?? []) {
            const from = Number(range.start?.slice(0, 2));
            const to = Number(range.end?.slice(0, 2));
            if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
            // A range ending at :00 doesn't include that hour; anything past
            // the hour mark does, so round the end up.
            const endHour = range.end?.slice(3) === '00' ? to : to + 1;
            for (let h = from; h < endHour && h < 24; h++) set.add(h);
          }
          return set;
        });
        // An enabled-but-empty schedule would mark everything after-hours,
        // which is never what the admin meant.
        const any = byDay.some((s) => s.size > 0);
        setState({
          byDay: any ? byDay : fallbackByDay(),
          configured: any,
          loading: false,
        });
      } catch {
        setState({ byDay: fallbackByDay(), configured: false, loading: false });
      }
    })();
    return () => { cancelled = true; };
  }, [organization]);

  return state;
}

// =============== License / seat position ===============

export type OrgLicense = {
  seat_count: number;
  status: string;
  expires_at: string | null;
};

export function useOrgLicense() {
  const { organization } = useAuth();
  const [license, setLicense] = useState<OrgLicense | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!organization) {
      setLicense(null);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('licenses')
      .select('seat_count, status, expires_at')
      .eq('organization_id', organization.id)
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setLicense(
      data
        ? {
            seat_count: Number((data as { seat_count: number }).seat_count) || 0,
            status: (data as { status: string }).status,
            expires_at: (data as { expires_at: string | null }).expires_at,
          }
        : null,
    );
    setLoading(false);
  }, [organization]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { license, loading, refresh };
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
