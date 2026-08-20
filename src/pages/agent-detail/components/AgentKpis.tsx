import { Bar } from '@/pages/dashboard/components/ui';
import { C } from '@/pages/dashboard/components/chartKit';

/* Six figures for one agent, in the dashboard's KPI-strip shape.

   Replaces two stacked rows of 14 tiles (AgentStatCards + QuickStats) that
   overlapped badly: "Active / Worked" and "Active time" were the same number
   rendered twice, "Screenshots" appeared as both a capture toggle and a count,
   and "Capture Controls" had a tile, a full panel and a tab. The session facts
   those rows also carried now live in SessionPanel, and the screenshot/video
   counts live in the tab badges where they're actionable. */

type Props = {
  activeWorked: string;
  idleTime: string;
  systemOn: string;
  appsUsed: number;
  sitesVisited: number;
  alertsCount: number;
  /** Fraction of system-on time that was active, 0–100, or null if unknown. */
  activeShare: number | null;
  rangeLabel: string;
  /** Days with activity in the window — decides how System On describes itself. */
  daysCovered: number;
};

export default function AgentKpis({
  activeWorked,
  idleTime,
  systemOn,
  appsUsed,
  sitesVisited,
  alertsCount,
  activeShare,
  rangeLabel,
  daysCovered,
}: Props) {
  const cells = [
    {
      label: 'Active',
      value: activeWorked,
      sub: activeShare === null ? rangeLabel : `${activeShare}% of system-on`,
      icon: 'ri-flashlight-line',
      bar: activeShare,
    },
    { label: 'Idle', value: idleTime, sub: 'gaps in the window', icon: 'ri-timer-line' },
    {
      label: 'System on',
      value: systemOn,
      // Over several days it is the sum of each day's first→last span, not one
      // span — saying "first → last activity" there would read as one stretch
      // that included the nights.
      sub: daysCovered > 1 ? `summed over ${daysCovered} days` : 'first → last activity',
      icon: 'ri-computer-line',
    },
    { label: 'Apps used', value: String(appsUsed), sub: 'distinct applications', icon: 'ri-apps-line' },
    { label: 'Sites visited', value: String(sitesVisited), sub: 'distinct hosts', icon: 'ri-global-line' },
    {
      label: 'Alerts',
      value: String(alertsCount),
      sub: alertsCount === 0 ? 'none raised' : 'raised in the window',
      icon: 'ri-notification-3-line',
      tone: alertsCount > 0 ? 't-warning' : undefined,
    },
  ];

  return (
    <div className="panel rise overflow-hidden" style={{ ['--i' as string]: 0 }}>
      <div className="kpi-grid">
        {cells.map((cell) => (
          <div key={cell.label} className="px-3.5 py-3 min-w-0 flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 min-w-0">
              <i className={`${cell.icon} text-[12px] t3 flex-shrink-0`} />
              <span className="label truncate">{cell.label}</span>
            </span>

            <span className="block min-w-0">
              <span className={`num num-lg block ${cell.tone ?? ''}`}>{cell.value}</span>
              <span className="block text-[10px] t3 mt-1 truncate">{cell.sub}</span>
            </span>

            {/* Only the Active cell earns a bar — it's the one figure that is a
                share of something else on the same row.

                One accent, no traffic light: the 60/30 thresholds this used to
                switch colour on were invented here. Nothing in the product
                defines a "good" share of system-on time, and over a multi-day
                window the share is low by definition because system-on spans
                the nights. */}
            <span className="block h-[3px] mt-auto">
              {typeof cell.bar === 'number' && (
                <Bar pct={cell.bar} height={3} color={C.accent} />
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
