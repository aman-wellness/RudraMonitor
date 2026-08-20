import { useCallback, useState } from 'react';
import { useActivityLogs, useAgents, type UiAgent } from '@/lib/dataHooks';
import MonitorFilters from './MonitorFilters';
import { useRegisterRefresh } from './refreshBus';
import { formatDurationShort } from '@/lib/labels';
import Pagination, { usePagination } from './Pagination';

/* Idle periods the agents flagged in the last 24h.

   The threshold tile used to read a flat "5 min". That number lives on each
   agent row (agents.idle_threshold_secs) and is editable per agent, so a
   hardcoded caption is wrong the moment one machine is set differently — and
   right only by coincidence otherwise. Derived below, as a range when the fleet
   disagrees. */
const thresholdLabel = (agents: UiAgent[], agentFilter: string) => {
  const scope = agentFilter === 'all' ? agents : agents.filter((a) => a.id === agentFilter);
  const values = Array.from(
    new Set(scope.map((a) => a.idleThresholdSecs).filter((v): v is number => typeof v === 'number' && v > 0)),
  ).sort((a, b) => a - b);
  if (values.length === 0) return { value: '—', sub: 'not reported by any agent' };
  if (values.length === 1) return { value: formatDurationShort(values[0]), sub: 'agent setting' };
  return {
    value: `${formatDurationShort(values[0])}–${formatDurationShort(values[values.length - 1])}`,
    sub: `varies across ${values.length} settings`,
  };
};

export default function IdleTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [search, setSearch] = useState('');

  const { rows, loading, refresh } = useActivityLogs({ type: 'idle', agentId: agentFilter, sinceHours: 24, limit: 200 });
  useRegisterRefresh(useCallback(() => { void refresh(); }, [refresh]));

  const filtered = rows.filter((r) => {
    if (search === '') return true;
    const start = new Date(r.created_at).toLocaleString();
    return start.toLowerCase().includes(search.toLowerCase())
      || (r.agent_name ?? '').toLowerCase().includes(search.toLowerCase());
  });

  const totalIdle = filtered.reduce((acc, r) => acc + (r.duration ?? 0), 0);
  const { visible, page, pageCount, setPage, from, to, total } = usePagination(filtered);

  // Scaled to the current page so bars stay comparable while paging, matching
  // the Applications and Browser tabs.
  const longest = Math.max(1, ...visible.map((r) => r.duration ?? 0));
  const threshold = thresholdLabel(agents, agentFilter);
  // How many distinct people the listed periods belong to — "8 events" reads
  // very differently spread over one machine vs four.
  const peopleAffected = new Set(filtered.map((r) => r.agent_id)).size;

  const clock = (iso: string) => {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };
  const endClock = (iso: string, durSec: number) => {
    try {
      return new Date(new Date(iso).getTime() + durSec * 1000)
        .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  };

  const cells = [
    { label: 'Idle periods', value: String(filtered.length), sub: 'last 24 hours', icon: 'ri-pause-circle-line' },
    { label: 'Total idle', value: formatDurationShort(totalIdle), sub: 'summed across agents', icon: 'ri-timer-line' },
    {
      label: 'Employees',
      value: String(peopleAffected),
      sub: peopleAffected === 1 ? 'with idle time' : 'with idle time',
      icon: 'ri-team-line',
    },
    { label: 'Threshold', value: threshold.value, sub: threshold.sub, icon: 'ri-settings-3-line' },
  ];

  return (
    <div className="space-y-2.5">
      <div className="panel overflow-hidden">
        <div className="quad-grid">
          {cells.map((c) => (
            <div key={c.label} className="px-3.5 py-3 min-w-0">
              <span className="flex items-center gap-1.5">
                <i className={`${c.icon} text-[12px] t3`} />
                <span className="label">{c.label}</span>
              </span>
              <p className="num num-lg mt-1.5">{c.value}</p>
              <p className="text-[10px] t3 mt-1 truncate">{c.sub}</p>
            </div>
          ))}
        </div>
      </div>

      <MonitorFilters
        agents={agents}
        agentFilter={agentFilter}
        onAgentChange={setAgentFilter}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Employee or time…"
        count={
          filtered.length > 0 ? (
            <span className="text-[10.5px] t3 tnum">{filtered.length} of {rows.length}</span>
          ) : null
        }
      />

      <div className="panel overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-8 text-center">
            <i className="ri-timer-line text-[22px] t3 block mb-2" />
            <p className="text-[12.5px] t2">
              {rows.length === 0 ? 'No idle periods in the last 24 hours' : 'Nothing matches these filters'}
            </p>
            {rows.length === 0 && (
              <p className="text-[11px] t3 mt-1">
                Agents report a period once the keyboard and mouse have been quiet for the threshold above.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="d-table" style={{ minWidth: 560 }}>
              <thead>
                <tr className="hair-b">
                  <th>Employee</th>
                  <th className="text-right" style={{ width: 80 }}>Start</th>
                  <th className="text-right" style={{ width: 80 }}>End</th>
                  <th className="text-right" style={{ width: '34%' }}>Duration</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="avatar flex-shrink-0">
                          {(r.agent_name || 'U').charAt(0).toUpperCase()}
                        </span>
                        <span className="text-[12px] t1 truncate">{r.agent_name || 'Unknown'}</span>
                      </span>
                    </td>
                    <td className="text-right text-[11.5px] t2 tnum">{clock(r.created_at)}</td>
                    <td className="text-right text-[11.5px] t2 tnum">
                      {endClock(r.created_at, r.duration ?? 0)}
                    </td>
                    <td>
                      <span className="flex items-center gap-2.5 justify-end">
                        <span className="flex-1 min-w-[40px] hidden md:block">
                          <span className="track block" style={{ height: 4 }}>
                            <i
                              className="grow"
                              style={{
                                width: `${Math.max(1.5, ((r.duration ?? 0) / longest) * 100)}%`,
                                background: 'var(--d-warning)',
                              }}
                            />
                          </span>
                        </span>
                        <span className="text-[11.5px] t-warning tnum text-right w-[52px]">
                          {formatDurationShort(r.duration ?? 0)}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination
        page={page} pageCount={pageCount} from={from} to={to} total={total}
        onPage={setPage} unit="idle periods"
      />

      {loading && filtered.length === 0 && (
        <p className="text-center text-[11px] t3 py-3">Loading…</p>
      )}
    </div>
  );
}
