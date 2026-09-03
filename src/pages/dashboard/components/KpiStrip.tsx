import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  useAgents,
  useAlerts,
  useDlpRisk,
  useOrgProductivityDaily,
  useProductivityPerAgent,
  useAttendance,
} from '@/lib/dataHooks';
import { useAuth } from '@/context/AuthContext';
import { useRefreshOnTick } from '../refreshBus';
import { useFilterWindow } from '../filterContext';
import { Bar, Sparkline } from './ui';
import { C, formatHm } from './chartKit';

/* One panel, six cells divided by hairlines (`.kpi-grid` in index.css moves
   the hairlines as the column count changes).

   Every cell is the same three rows — label, figure, trend — so the six
   figures land on one optical baseline across the strip. That alignment is
   what makes this read as a single instrument rather than six loose boxes.
   Cells are links and lift on hover. */

type Cell = {
  label: string;
  value: string;
  sub?: string;
  spark?: { points: number[]; color: string };
  bar?: { pct: number; color: string };
  to?: string;
  tone?: string;
  icon: string;
};

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export default function KpiStrip() {
  const { organization } = useAuth();
  const w = useFilterWindow();
  const { agents: allAgents, refresh: refreshAgents } = useAgents();
  const { byAgent, refresh: refreshSplit } = useProductivityPerAgent(
    w.sinceHours, w.untilHours,
  );
  // A longer daily window than the filter, purely to give the sparklines a
  // trend line to draw — the figures themselves come from the filtered window.
  const { rows: daily, refresh: refreshDaily } = useOrgProductivityDaily(
    Math.max(14, w.days), w.untilHours, w.agentId,
  );
  const { rows: alertRows, refresh: refreshAlerts } = useAlerts({
    sinceHours: Math.max(w.sinceHours, 24 * 14),
    untilHours: w.untilHours,
    agentId: w.agentId,
    limit: 1000,
  });
  const { summary: dlp, refresh: refreshDlp } = useDlpRisk(w.sinceHours, w.untilHours, w.agentId);
  useRefreshOnTick(refreshAgents, refreshSplit, refreshDaily, refreshAlerts, refreshDlp);

  // Scoped to the picked agent where that's meaningful; seats stay org-wide.
  const agents = useMemo(
    () => (w.agentId ? allAgents.filter((a) => a.id === w.agentId) : allAgents),
    [allAgents, w.agentId],
  );
  const total = agents.length;
  const online = agents.filter((a) => a.status === 'online').length;
  const idle = agents.filter((a) => a.status === 'idle').length;
  const onlinePct = total > 0 ? Math.round(((online + idle) / total) * 100) : 0;
  const seats = organization?.license_count ?? 0;
  const scoped = w.agentId !== null;

  // One pass over the per-agent aggregate so these always agree with the donut
  // and the per-agent table column.
  const today = useMemo(() => {
    let productive = 0;
    let unproductive = 0;
    let active = 0;
    let reporting = 0;
    for (const agg of Object.values(byAgent)) {
      if (w.agentId && agg.agent_id !== w.agentId) continue;
      productive += agg.weighted_seconds;
      unproductive += agg.unproductive_seconds;
      active += agg.active_seconds;
      if (agg.active_seconds > 0) reporting += 1;
    }
    const matched = productive + unproductive;
    return {
      pct: matched > 0 ? Math.round((productive / matched) * 100) : null,
      avgSeconds: reporting > 0 ? active / reporting : 0,
      reporting,
    };
  }, [byAgent, w.agentId]);


  // ---- histories for the sparklines ----
  const fleetSeries = useMemo(() => {
    const t0 = startOfDay(new Date()).getTime();
    return Array.from({ length: 14 }, (_, i) => {
      const cutoff = t0 + (i - 12) * 86400000; // end of each of the last 14 days
      return agents.filter((a) => new Date(a.createdAt).getTime() < cutoff).length;
    });
  }, [agents]);


  const alertSeries = useMemo(() => {
    const t0 = startOfDay(new Date()).getTime();
    const buckets = Array.from({ length: 15 }, () => 0);
    for (const a of alertRows) {
      const d = startOfDay(new Date(a.created_at)).getTime();
      const idx = 14 - Math.round((t0 - d) / 86400000);
      if (idx >= 0 && idx < 15) buckets[idx] += 1;
    }
    return buckets;
  }, [alertRows]);

  const openAlerts = useMemo(() => {
    const start = w.from.getTime();
    const end = w.to.getTime();
    return alertRows.filter((a) => {
      const t = new Date(a.created_at).getTime();
      return !a.ai_resolved && t >= start && t <= end;
    }).length;
  }, [alertRows, w.from, w.to]);

  // Matches the window of the number above it (last 24h), and counts alerts
  // RAISED rather than still-unresolved: older windows have had longer for
  // things to be resolved, so trending "unresolved" would make every fresh
  // window look worse than the one before it.

  const productivitySeries = useMemo(
    () => daily.filter((d) => d.active_seconds > 0).map((d) => d.productivity_pct),
    [daily],
  );


  const hoursSeries = useMemo(
    () => daily.map((d) => Math.round((d.active_seconds / 3600) * 10) / 10),
    [daily],
  );

  // Attendance shortfall — count of agents whose most recent day's
  // session_minutes fell below the org's daily target. Only counts
  // the LATEST day in the range so it reads as "who is short today"
  // rather than a running total across the whole week.
  const { rows: attendanceRows } = useAttendance(0);
  const shortfallCount = useMemo(() => {
    let today = '';
    for (const r of attendanceRows) if (r.work_date > today) today = r.work_date;
    return attendanceRows.filter((r) => r.work_date === today && !r.met_target).length;
  }, [attendanceRows]);


  const cells: Cell[] = [
    {
      label: 'Fleet',
      value: String(total),
      sub: scoped ? 'selected agent' : seats > 0 ? `${total} of ${seats} seats` : `${total} enrolled`,
      spark: scoped ? undefined : { points: fleetSeries, color: C.success },
      to: '/agents',
      icon: 'ri-computer-line',
    },
    {
      label: 'Live now',
      value: String(online + idle),
      sub: total > 0 ? `${onlinePct}% reachable now` : 'no agents yet',
      bar: { pct: onlinePct, color: onlinePct >= 50 ? C.success : C.warning },
      to: '/monitoring',
      icon: 'ri-wifi-line',
    },
    {
      label: 'Productivity',
      value: today.pct === null ? '—' : `${today.pct}%`,
      sub: today.pct === null ? 'no rules matched' : `matched time · ${w.label}`,
      spark: { points: productivitySeries, color: C.success },
      to: '/reports',
      icon: 'ri-pulse-line',
    },
    {
      label: 'Hours / agent',
      value: formatHm(today.avgSeconds),
      sub: `${today.reporting} reporting · ${w.label}`,
      spark: { points: hoursSeries, color: C.accent2 },
      to: '/reports',
      icon: 'ri-time-line',
    },
    {
      label: 'Open alerts',
      value: String(openAlerts),
      sub: openAlerts === 0 ? `all clear · ${w.label}` : `to review · ${w.label}`,
      spark: { points: alertSeries, color: C.warning },
      to: '/alerts',
      tone: openAlerts > 0 ? 't-warning' : undefined,
      icon: 'ri-notification-3-line',
    },
    {
      label: 'DLP risk',
      value: String(dlp.serious),
      sub: `of ${dlp.current} event${dlp.current === 1 ? '' : 's'} · ${w.label}`,
      to: '/dlp',
      tone: dlp.serious > 0 ? 't-danger' : undefined,
      icon: 'ri-shield-keyhole-line',
    },
    {
      label: 'Below target',
      value: String(shortfallCount),
      sub:
        shortfallCount === 0
          ? 'all agents met 8h 45m today'
          : `agent${shortfallCount === 1 ? '' : 's'} short of 8h 45m today`,
      to: '/reports?tab=time',
      tone: shortfallCount > 0 ? 't-warning' : undefined,
      icon: 'ri-timer-flash-line',
    },
  ];

  // Each metric is its own card rather than a cell in one hairline-divided
  // panel. Seven cards, one per metric — nothing merged, nothing dropped.
  return (
    <div className="kpi-cards">
      {cells.map((cell, i) => {
        const body = (
          <>
            <span className="kpi-card-top">
              <i className={`${cell.icon} text-[13px] flex-shrink-0`} />
              <span className="label truncate">{cell.label}</span>
            </span>

            <span className="block min-w-0">
              <span className={`num num-xl block ${cell.tone ?? ''}`}>{cell.value}</span>
              {cell.sub && (
                <span className="block text-[10.5px] t3 mt-1 truncate">{cell.sub}</span>
              )}
            </span>

            {/* Bottom slot: the share bar where a cell has one, otherwise its
                sparkline. Always rendered so the figures stay on one optical
                baseline across the row. */}
            <span className="kpi-card-foot">
              {cell.bar ? (
                <Bar pct={cell.bar.pct} color={cell.bar.color} height={3} />
              ) : cell.spark && cell.spark.points.length > 1 ? (
                <Sparkline
                  points={cell.spark.points}
                  color={cell.spark.color}
                  w={120}
                  h={22}
                />
              ) : null}
            </span>
          </>
        );

        return cell.to ? (
          <Link
            key={cell.label}
            to={cell.to}
            className="panel rise kpi-card"
            style={{ ['--i' as string]: i }}
          >
            {body}
          </Link>
        ) : (
          <div
            key={cell.label}
            className="panel rise kpi-card"
            style={{ ['--i' as string]: i }}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}
