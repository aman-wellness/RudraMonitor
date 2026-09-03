import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAttendance } from '@/lib/dataHooks';
import { useRefreshOnTick } from '../refreshBus';
import { EmptyNote, MicroLabel, Panel } from './ui';

/* Time tracker — who logged in when, who's short on hours.

     Two questions, one card:

       1. TODAY: for each agent that reported, what was the first login and
          last activity — with a colored pill for late / early / short.
       2. THIS WEEK: who is behind on target hours across the last 7 days.
          Ranked worst-first so the reviewer sees the risk immediately.

     Everything is derived from the attendance_daily RPC (migration 0151);
     no new backend surface. */

const START_OF_DAY = '09:30'; // matches org tracking_schedule_json default
const END_OF_DAY = '18:30';

function hhmm(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function classifyStart(loginIso: string | null): 'ontime' | 'late' | 'unknown' {
  if (!loginIso) return 'unknown';
  const d = new Date(loginIso);
  const local = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return local > START_OF_DAY ? 'late' : 'ontime';
}

function classifyEnd(logoutIso: string | null): 'ontime' | 'early' | 'unknown' {
  if (!logoutIso) return 'unknown';
  const d = new Date(logoutIso);
  const local = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return local < END_OF_DAY ? 'early' : 'ontime';
}

export default function TimeTracker({ index = 0 }: { index?: number }) {
  const { rows, loading, refresh } = useAttendance(6);
  useRefreshOnTick(refresh);

  const model = useMemo(() => {
    const today = ymd(new Date());

    const todayRows = rows.filter((r) => r.work_date === today);
    const todaySorted = [...todayRows].sort((a, b) => {
      const at = a.first_login ? new Date(a.first_login).getTime() : Number.POSITIVE_INFINITY;
      const bt = b.first_login ? new Date(b.first_login).getTime() : Number.POSITIVE_INFINITY;
      return at - bt;
    });

    const weekByAgent: Record<string, {
      agent_id: string;
      agent_name: string;
      totalShortfallMin: number;
      daysShort: number;
      daysMet: number;
      totalMinutes: number;
    }> = {};
    for (const r of rows) {
      if (!weekByAgent[r.agent_id]) {
        weekByAgent[r.agent_id] = {
          agent_id: r.agent_id,
          agent_name: r.agent_name,
          totalShortfallMin: 0,
          daysShort: 0,
          daysMet: 0,
          totalMinutes: 0,
        };
      }
      const w = weekByAgent[r.agent_id];
      w.totalMinutes += r.session_minutes;
      if (r.met_target) w.daysMet++;
      else {
        w.daysShort++;
        w.totalShortfallMin += r.shortfall_minutes;
      }
    }
    const weekAgents = Object.values(weekByAgent).sort(
      (a, b) => b.totalShortfallMin - a.totalShortfallMin,
    );

    return {
      today: todaySorted,
      week: weekAgents,
      todayCount: todayRows.length,
      todayLate: todayRows.filter((r) => classifyStart(r.first_login) === 'late').length,
      todayMissedTarget: todayRows.filter((r) => !r.met_target).length,
    };
  }, [rows]);

  return (
    <Panel
      index={index}
      title="Time tracker"
      hint="Login, logout, and weekly hours shortfall"
      action={
        <div className="flex items-center gap-3 text-xs">
          <span className="text-slate-500 dark:text-slate-400">{model.todayCount} today</span>
          {model.todayLate > 0 && (
            <span className="text-amber-600 dark:text-amber-400">{model.todayLate} late</span>
          )}
          {model.todayMissedTarget > 0 && (
            <span className="text-rose-600 dark:text-rose-400">{model.todayMissedTarget} short</span>
          )}
          <Link
            to="/reports"
            className="text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            Full report →
          </Link>
        </div>
      }
    >
      {loading && rows.length === 0 ? (
        <EmptyNote title="Loading attendance…" />
      ) : model.today.length === 0 && model.week.length === 0 ? (
        <EmptyNote
          title="No attendance yet"
          hint="Login and logout events appear once agents start reporting."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {/* Today */}
          <div className="min-w-0">
            <MicroLabel className="mb-2">Today · login &amp; logout</MicroLabel>
            {model.today.length === 0 ? (
              <div className="text-sm text-slate-500 dark:text-slate-400 py-2">
                No agent has logged in today yet.
              </div>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="text-left font-medium py-1 px-1">Agent</th>
                      <th className="text-left font-medium py-1 px-1">In</th>
                      <th className="text-left font-medium py-1 px-1">Out</th>
                      <th className="text-right font-medium py-1 px-1">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.today.slice(0, 8).map((r) => {
                      const startClass = classifyStart(r.first_login);
                      const endClass = classifyEnd(r.last_activity);
                      return (
                        <tr
                          key={r.agent_id}
                          className="border-t border-slate-100 dark:border-slate-800"
                        >
                          <td className="py-1.5 px-1 truncate max-w-[8rem]" title={r.agent_name}>
                            <Link
                              to={`/agents/${r.agent_id}`}
                              className="hover:underline text-slate-800 dark:text-slate-100"
                            >
                              {r.agent_name}
                            </Link>
                          </td>
                          <td className="py-1.5 px-1 tabular-nums">
                            <span
                              className={
                                startClass === 'late'
                                  ? 'text-amber-600 dark:text-amber-400 font-medium'
                                  : 'text-slate-700 dark:text-slate-200'
                              }
                            >
                              {hhmm(r.first_login)}
                            </span>
                            {startClass === 'late' && (
                              <span className="ml-1 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
                                late
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-1 tabular-nums">
                            <span
                              className={
                                endClass === 'early'
                                  ? 'text-rose-600 dark:text-rose-400 font-medium'
                                  : 'text-slate-700 dark:text-slate-200'
                              }
                            >
                              {hhmm(r.last_activity)}
                            </span>
                            {endClass === 'early' && (
                              <span className="ml-1 text-[10px] uppercase tracking-wide text-rose-600 dark:text-rose-400">
                                early
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-1 text-right tabular-nums">
                            <span
                              className={
                                r.met_target
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-slate-700 dark:text-slate-200'
                              }
                            >
                              {fmtDuration(r.session_minutes)}
                            </span>
                            {!r.met_target && r.shortfall_minutes > 0 && (
                              <div className="text-[10px] text-rose-600 dark:text-rose-400">
                                −{fmtDuration(r.shortfall_minutes)}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {model.today.length > 8 && (
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 px-1">
                    + {model.today.length - 8} more
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Week */}
          <div className="min-w-0">
            <MicroLabel className="mb-2">This week · shortfall leaderboard</MicroLabel>
            {model.week.length === 0 ? (
              <div className="text-sm text-slate-500 dark:text-slate-400 py-2">
                No attendance in the last 7 days.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {model.week
                  .filter((w) => w.totalShortfallMin > 0)
                  .slice(0, 8)
                  .map((w) => {
                    const totalDays = w.daysMet + w.daysShort;
                    return (
                      <li key={w.agent_id} className="py-1.5 flex items-center gap-2">
                        <Link
                          to={`/agents/${w.agent_id}`}
                          className="min-w-0 flex-1 truncate hover:underline text-slate-800 dark:text-slate-100"
                          title={w.agent_name}
                        >
                          {w.agent_name}
                        </Link>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                          {w.daysShort}/{totalDays} days short
                        </span>
                        <span className="tabular-nums text-rose-600 dark:text-rose-400 font-medium">
                          −{fmtDuration(w.totalShortfallMin)}
                        </span>
                      </li>
                    );
                  })}
                {model.week.every((w) => w.totalShortfallMin === 0) && (
                  <li className="py-2 text-sm text-emerald-600 dark:text-emerald-400">
                    Every agent hit target this week.
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
