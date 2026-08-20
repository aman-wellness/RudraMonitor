import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

/* Fleet hardware metrics for the System Health page.
 *
 * Why this exists instead of reusing useLatestSystemMetrics: that hook only
 * queries the last THIRTY MINUTES. When the newest sample is older than that it
 * returns nothing, and this page's `m?.cpu_usage ?? 0` turned "no recent sample"
 * into a measured **0%** — so the page showed "Avg CPU 0%", "Avg Memory 0%",
 * empty usage bars and "All agents are running healthy" for a fleet whose last
 * readings included a machine at 96% CPU / 93% RAM. "Last Seen" said "never" for
 * agents that had reported hours earlier.
 *
 * So: read a real window, keep the last known reading per agent with its age,
 * and let the UI say plainly whether a number is live or last-known. The same
 * rows also feed the trend chart, which is what the agent-detail card has always
 * pointed at this page for.
 */

export type Sample = {
  agent_id: string;
  cpu_usage: number | null;
  ram_usage: number | null;
  disk_usage: number | null;
  battery_level: number | null;
  network_speed: string | null;
  recorded_at: string;
};

export type AgentMetrics = {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  battery: number | null;
  network: string | null;
  down: number | null;
  up: number | null;
  recordedAt: string | null;
  ageMs: number | null;
  /** A sample newer than the reporting interval allows — safe to call "now". */
  fresh: boolean;
};

/** Agents push metrics every 60s, so anything older than 3 min isn't live. */
export const STALE_AFTER_MS = 3 * 60 * 1000;

/* Utilisation levels a reading is judged against.
 *
 * PER METRIC on purpose: a disk sitting at 60% is completely normal, while a CPU
 * pinned at 60% is worth a look — one shared number (this page used 60 for all
 * three) flagged three idle laptops for having a half-full disk. Nothing in the
 * product stores these, so they are stated in the UI rather than applied
 * silently, and `high` matches the dashboard's own 90% "under load" line so the
 * two screens can't disagree about the same machine. */
export const LIMITS = {
  cpu:    { watch: 70, high: 90 },
  memory: { watch: 75, high: 90 },
  disk:   { watch: 80, high: 90 },
} as const;

export type MetricKey = keyof typeof LIMITS;

/** How far past its watch level a reading is, 0 when under it. Used to rank the
 *  attention queue so a CPU at 95 outranks a disk at 82. */
export const overage = (key: MetricKey, v: number | null) =>
  v === null ? 0 : Math.max(0, v - LIMITS[key].watch);

export const WINDOWS = [
  { id: '6h', label: '6h', hours: 6 },
  { id: '24h', label: '24h', hours: 24 },
  { id: '7d', label: '7 days', hours: 24 * 7 },
] as const;

export type WindowId = (typeof WINDOWS)[number]['id'];

/** Pull the two Mbps numbers out of the agent's network_speed string. Returns
 *  null rather than 0 when there's nothing to parse — 0 Mbps is a reading. */
export const parseNet = (s: string | null): { down: number | null; up: number | null } => {
  if (!s) return { down: null, up: null };
  const nums = (s.match(/[\d.]+/g) ?? []).map(Number);
  return { down: nums[0] ?? null, up: nums[1] ?? null };
};

export const formatAge = (ageMs: number | null): string => {
  if (ageMs === null) return 'no data';
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export type Bucket = {
  /** Bucket start, ms. */
  t: number;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  samples: number;
};

const BUCKETS = 28;

export function useFleetMetrics(windowId: WindowId, agentIds: string[]) {
  const { organization } = useAuth();
  const orgId = organization?.id ?? null;
  const hours = WINDOWS.find((w) => w.id === windowId)?.hours ?? 24;
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);

  // Scale the row cap to the fleet so a big org still gets every agent's latest
  // sample, and report when we hit it instead of silently showing a partial fleet.
  const cap = Math.min(8000, Math.max(1000, agentIds.length * 200));

  const refresh = useCallback(async () => {
    if (!orgId) { setSamples([]); setLoading(false); return; }
    setLoading(true);
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('system_metrics')
      .select('agent_id, cpu_usage, ram_usage, disk_usage, battery_level, network_speed, recorded_at, agents!inner(org_id)')
      .gte('recorded_at', since)
      .eq('agents.org_id', orgId)
      .order('recorded_at', { ascending: false })
      .limit(cap);
    if (!error && data) {
      setSamples(data as unknown as Sample[]);
      setTruncated(data.length >= cap);
    }
    setLoading(false);
  }, [orgId, hours, cap]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Agents report every 60s; re-read on the same cadence so the page is live
  // without a manual refresh.
  useEffect(() => {
    const id = window.setInterval(() => { void refresh(); }, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  /** Latest sample per agent — samples arrive newest-first, so first wins. */
  const byAgent = useMemo(() => {
    const now = Date.now();
    const out: Record<string, AgentMetrics> = {};
    for (const s of samples) {
      if (out[s.agent_id]) continue;
      const ageMs = now - new Date(s.recorded_at).getTime();
      const { down, up } = parseNet(s.network_speed);
      out[s.agent_id] = {
        cpu: s.cpu_usage,
        memory: s.ram_usage,
        disk: s.disk_usage,
        battery: s.battery_level,
        network: s.network_speed,
        down,
        up,
        recordedAt: s.recorded_at,
        ageMs,
        fresh: ageMs <= STALE_AFTER_MS,
      };
    }
    // Agents with nothing in the window get an explicit no-data entry rather
    // than zeros.
    for (const id of agentIds) {
      if (!out[id]) {
        out[id] = {
          cpu: null, memory: null, disk: null, battery: null, network: null,
          down: null, up: null, recordedAt: null, ageMs: null, fresh: false,
        };
      }
    }
    return out;
  }, [samples, agentIds]);

  /** Fleet averages over time. Buckets with no samples stay null so the chart
   *  can show a gap instead of drawing a line through a reporting outage. */
  const series = useMemo<Bucket[]>(() => {
    const now = Date.now();
    const span = hours * 3600 * 1000;
    const start = now - span;
    const size = span / BUCKETS;
    const acc = Array.from({ length: BUCKETS }, () => ({ cpu: 0, mem: 0, disk: 0, n: 0 }));
    for (const s of samples) {
      const t = new Date(s.recorded_at).getTime();
      const i = Math.min(BUCKETS - 1, Math.max(0, Math.floor((t - start) / size)));
      const b = acc[i];
      b.cpu += s.cpu_usage ?? 0;
      b.mem += s.ram_usage ?? 0;
      b.disk += s.disk_usage ?? 0;
      b.n += 1;
    }
    return acc.map((b, i) => ({
      t: start + i * size,
      cpu: b.n ? Math.round(b.cpu / b.n) : null,
      memory: b.n ? Math.round(b.mem / b.n) : null,
      disk: b.n ? Math.round(b.disk / b.n) : null,
      samples: b.n,
    }));
  }, [samples, hours]);

  return { byAgent, series, samples, loading, truncated, refresh, hours };
}
