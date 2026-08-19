import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAgents, useAlerts, useLatestSystemMetrics, useOrgLicense } from '@/lib/dataHooks';
import { useAuth } from '@/context/AuthContext';
import { useRefreshOnTick } from '../refreshBus';
import { Bar, MicroLabel, Panel } from './ui';
import { C } from './chartKit';

/* Fleet + commercial health — the three things an owner is accountable for:

     1. Are the machines healthy right now (telemetry, load, alerts)?
     2. Am I paying for seats nobody is using?
     3. Is any enrolled agent silently not reporting — a monitoring gap?

   Silent agents matter most: they look "offline" like a laptop at home, but a
   machine silent for days is uninstalled, blocked, or seat-locked.

   The ring gets a sentence next to it rather than a caption inside it: "80%"
   alone doesn't say 80% of what, and at this size no caption fits in the hole.
   The three blocks are separated by hairlines and each carries its own
   micro-label so the card reads as three answers, not one list. */

const FRESH_MS = 5 * 60 * 1000;
const SILENT_MS = 24 * 60 * 60 * 1000;
const PRESSURE_PCT = 90;

const SIZE = 84;
const R = 33;
const STROKE = 10;
const CIRC = 2 * Math.PI * R;

export default function FleetHealthPanel({ index = 0 }: { index?: number }) {
  const { organization } = useAuth();
  const { agents, refresh: refreshAgents } = useAgents();
  const { byAgent, refresh: refreshMetrics } = useLatestSystemMetrics();
  const { rows: alertRows, refresh: refreshAlerts } = useAlerts({ sinceHours: 24, limit: 200 });
  const { license, refresh: refreshLicense } = useOrgLicense();
  useRefreshOnTick(refreshAgents, refreshMetrics, refreshAlerts, refreshLicense);

  const model = useMemo(() => {
    const now = Date.now();
    const total = agents.length;

    const fresh = agents.filter((a) => {
      const m = byAgent[a.id];
      return m && now - new Date(m.recorded_at).getTime() <= FRESH_MS;
    });
    const pressured = fresh.filter((a) => {
      const m = byAgent[a.id];
      if (!m) return false;
      return (
        (m.cpu_usage ?? 0) > PRESSURE_PCT ||
        (m.ram_usage ?? 0) > PRESSURE_PCT ||
        (m.disk_usage ?? 0) > PRESSURE_PCT
      );
    });

    const critical = alertRows.filter((a) => a.alert_type === 'error' && !a.ai_resolved);
    const criticalAgents = new Set(critical.map((a) => a.agent_id));

    const silent = agents.filter((a) => {
      if (a.lastActive === '-') return true;
      return now - new Date(a.lastActive).getTime() > SILENT_MS;
    });

    const healthy = fresh.filter((a) => !pressured.includes(a) && !criticalAgents.has(a.id)).length;
    const score = fresh.length > 0 ? Math.round((healthy / fresh.length) * 100) : null;

    const seats = license?.seat_count ?? organization?.license_count ?? 0;
    const daysToRenewal = license?.expires_at
      ? Math.ceil((new Date(license.expires_at).getTime() - now) / 86400000)
      : null;

    return {
      total,
      reporting: fresh.length,
      healthy,
      pressured: pressured.length,
      critical: critical.length,
      silent,
      score,
      seats,
      seatPct: seats > 0 ? Math.round((total / seats) * 100) : 0,
      daysToRenewal,
    };
  }, [agents, byAgent, alertRows, license, organization]);

  // Four steps, so a merely-imperfect score doesn't shout in alarm red the way
  // a two-step scale made 80% look.
  const ringColor =
    model.score === null
      ? C.neutral
      : model.score >= 95
        ? C.success
        : model.score >= 75
          ? C.accent
          : model.score >= 50
            ? C.warning
            : C.danger;

  const checks: { label: string; value: string; ok: boolean | null; hint?: string }[] = [
    {
      label: 'Live telemetry',
      value: `${model.reporting}/${model.total}`,
      ok: model.total === 0 ? null : model.reporting > 0,
      hint: 'Agents that reported hardware metrics in the last 5 minutes',
    },
    {
      label: model.critical === 0 ? 'No critical alerts' : 'Critical alerts',
      value: model.critical === 0 ? 'clear' : String(model.critical),
      ok: model.critical === 0,
      hint: 'Unresolved error-level alerts in the last 24 hours',
    },
    {
      label: model.pressured === 0 ? 'Resources healthy' : 'Under load',
      value:
        model.reporting === 0
          ? '—'
          : model.pressured === 0
            ? 'ok'
            : `${model.pressured} agent${model.pressured === 1 ? '' : 's'}`,
      ok: model.reporting === 0 ? null : model.pressured === 0,
      hint: `CPU, RAM or disk above ${PRESSURE_PCT}%`,
    },
  ];

  const centre = SIZE / 2;
  const spare = model.seats - model.total;

  return (
    <Panel
      title="Fleet & licence health"
      // Deliberately ignores the date filter: telemetry freshness, seat count
      // and "silent right now" are all present-tense facts. Saying so beats
      // showing a stale reading that looks current.
      hint={<span className="live-tag"><span className="live-dot" />Live</span>}
      index={index}
      action={
        <Link to="/system-health" className="chip chip-quiet text-[9.5px]">
          Details
          <i className="ri-arrow-right-line" />
        </Link>
      }
    >
      {/* ---- score ---- */}
      <div className="flex items-center gap-3.5">
        <div className="relative flex-shrink-0" style={{ width: SIZE, height: SIZE }}>
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="fade-in">
            <circle cx={centre} cy={centre} r={R} fill="none" stroke={C.track} strokeWidth={STROKE} />
            {model.score !== null && (
              <circle
                cx={centre}
                cy={centre}
                r={R}
                fill="none"
                stroke={ringColor}
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={`${((model.score / 100) * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`}
                transform={`rotate(-90 ${centre} ${centre})`}
              />
            )}
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="num" style={{ fontSize: 20 }}>
              {model.score === null ? '—' : `${model.score}%`}
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <MicroLabel>Machine health</MicroLabel>
          <p className="text-[11.5px] t2 mt-1 leading-snug">
            {model.score === null ? (
              <>
                No agent has reported hardware metrics in the last 5 minutes, so there&apos;s
                nothing to score yet.
              </>
            ) : (
              <>
                <span className="t1 font-medium">
                  {model.healthy} of {model.reporting}
                </span>{' '}
                reporting agent{model.reporting === 1 ? '' : 's'} clear of load and critical alerts.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="space-y-0.5 mt-2.5">
        {checks.map((c) => (
          <div key={c.label} className={`check ${c.ok === false ? 'is-bad' : ''}`} title={c.hint}>
            <i
              className={`text-[12px] flex-shrink-0 ${
                c.ok === null
                  ? 'ri-subtract-line t3'
                  : c.ok
                    ? 'ri-checkbox-circle-fill t-success'
                    : 'ri-error-warning-fill t-danger'
              }`}
            />
            <span className="text-[11px] t2 flex-1 truncate">{c.label}</span>
            <span
              className={`text-[11px] tnum flex-shrink-0 ${c.ok === false ? 't-danger font-medium' : 't3'}`}
            >
              {c.value}
            </span>
          </div>
        ))}
      </div>

      {/* ---- seats: the "over-paying / about to be blocked" line ---- */}
      <div className="mt-3 pt-2.5 hair-t">
        <div className="flex items-baseline justify-between gap-2 mb-1.5">
          <MicroLabel>Seat utilisation</MicroLabel>
          <span className="text-[11px] tnum">
            <span className="t1 font-medium">{model.total}</span>
            <span className="t3"> / {model.seats || '—'}</span>
          </span>
        </div>
        <Bar
          pct={model.seatPct}
          height={6}
          color={model.seatPct >= 100 ? C.danger : model.seatPct >= 85 ? C.warning : C.accent}
        />
        <div className="flex items-baseline justify-between gap-2 mt-1.5">
          <span className="text-[9.5px] t3">
            {model.seats === 0
              ? 'No licence on file'
              : spare <= 0
                ? 'At capacity — new agents blocked'
                : `${spare} seat${spare === 1 ? '' : 's'} spare`}
          </span>
          {model.daysToRenewal !== null && (
            <span className={`text-[9.5px] ${model.daysToRenewal <= 14 ? 't-warning' : 't3'}`}>
              renews in {model.daysToRenewal}d
            </span>
          )}
        </div>
      </div>

      {/* ---- silent agents: enrolled, paid for, reporting nothing ---- */}
      <div className="mt-auto pt-2.5 hair-t">
        <div className="flex items-baseline justify-between gap-2">
          <MicroLabel>Silent over 24h</MicroLabel>
          <span
            className={`text-[11px] font-medium tnum ${model.silent.length > 0 ? 't-warning' : 't3'}`}
          >
            {model.silent.length}
          </span>
        </div>
        {model.silent.length === 0 ? (
          <p className="text-[9.5px] t3 mt-1.5">Every agent has checked in today.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {model.silent.slice(0, 4).map((a) => (
              <Link
                key={a.id}
                to={`/agents/${a.id}`}
                className="chip chip-warning text-[9.5px] px-2 py-0.5"
                title={
                  a.lastActive === '-'
                    ? 'Never reported'
                    : `Last seen ${new Date(a.lastActive).toLocaleString()}`
                }
              >
                {a.name}
              </Link>
            ))}
            {model.silent.length > 4 && (
              <span className="text-[9.5px] t3 self-center">+{model.silent.length - 4} more</span>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
