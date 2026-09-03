import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useActivityLogs,
  useAgentActivityHourly,
  useAgents,
  useProductivityPerAgent,
} from '@/lib/dataHooks';
import { useRefreshOnTick } from '../refreshBus';
import { useFilterWindow } from '../filterContext';
import { Bar, Panel } from './ui';
import { C, formatHm, rampOpacity } from './chartKit';

/* Compact fleet table.

   Two things beyond styling:
     • PRESENCE — 24 slim bars per agent, one per hour of today. "5h 12m" gives
       the total; the strip says whether that was one solid block or scattered
       across the night.
     • Real productivity/hours/apps merged from the aggregation RPC — useAgents
       alone returns 0 for all three because it doesn't join activity_logs. */

type Filter = 'all' | 'online' | 'idle' | 'offline';

const formatIdle = (seconds: number) => `${Math.round(seconds / 60)}m`;

const OS_ICON = (os: string) => {
  if (os.includes('Windows')) return 'ri-windows-fill';
  if (os.includes('macOS') || os.includes('Darwin')) return 'ri-apple-fill';
  return 'ri-ubuntu-fill';
};

const STATUS: Record<string, { cls: string; label: string }> = {
  online: { cls: 't-success', label: 'Online' },
  idle: { cls: 't-warning', label: 'Idle' },
  offline: { cls: 't3', label: 'Offline' },
};

/** 24 slim bars, midnight → now, intensity by active seconds that hour. */
function PresenceStrip({ hours }: { hours: Record<number, number> }) {
  const cells = useMemo(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const values = Array.from(
      { length: 24 },
      (_, h) => hours[midnight.getTime() + h * 3600000] ?? 0,
    );
    const max = Math.max(1, ...values);
    return values.map((v, h) => ({ h, o: rampOpacity(v, max) }));
  }, [hours]);

  return (
    <span className="pres" title="Active hours today (midnight → now)">
      {cells.map((c) => (
        <span key={c.h}>
          <i style={{ opacity: c.o }} />
        </span>
      ))}
    </span>
  );
}

export default function AgentTable({ index = 0 }: { index?: number }) {
  const navigate = useNavigate();
  const w = useFilterWindow();
  const { agents: allAgents, loading, refresh: refreshAgents } = useAgents();
  const { byAgent: productivityByAgent, refresh: refreshProductivity } = useProductivityPerAgent(
    w.sinceHours, w.untilHours,
  );
  const { rows: recentActivity, refresh: refreshActivity } = useActivityLogs({
    sinceHours: w.sinceHours,
    untilHours: w.untilHours,
    agentId: w.agentId ?? undefined,
    limit: 500,
  });
  // The presence strip is always a 24-hour shape; it ends on the range's last
  // day so a historical range shows that day rather than today.
  const { byAgent: hourlyByAgent, refresh: refreshHourly } = useAgentActivityHourly(
    24, w.untilHours, w.agentId,
  );
  const rawAgents = useMemo(
    () => (w.agentId ? allAgents.filter((a) => a.id === w.agentId) : allAgents),
    [allAgents, w.agentId],
  );
  useRefreshOnTick(refreshAgents, refreshProductivity, refreshActivity, refreshHourly);

  const recentAppsByAgent = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const r of recentActivity) {
      if (r.activity_type !== 'app' || !r.application_name) continue;
      const list = out[r.agent_id] ?? (out[r.agent_id] = []);
      // rows arrive newest-first; keep the first 3 distinct apps per agent.
      if (list.length < 3 && !list.includes(r.application_name)) list.push(r.application_name);
    }
    return out;
  }, [recentActivity]);

  const agents = useMemo(
    () =>
      rawAgents.map((a) => {
        const p = productivityByAgent[a.id];
        const matched = p ? p.weighted_seconds + p.unproductive_seconds : 0;
        return {
          ...a,
          // null = no rule-matched time, which is not the same as 0%.
          productivity: matched > 0 ? Math.round((p!.weighted_seconds / matched) * 100) : null,
          activeSeconds: p?.active_seconds ?? 0,
          idleSeconds: p?.idle_seconds ?? 0,
          applications: recentAppsByAgent[a.id] ?? [],
        };
      }),
    [rawAgents, productivityByAgent, recentAppsByAgent],
  );

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);

  // Dismiss the row menu on any outside click. The menu's own buttons call
  // stopPropagation, so they fire before this closes it.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuFor]);

  const counts = {
    all: agents.length,
    online: agents.filter((a) => a.status === 'online').length,
    idle: agents.filter((a) => a.status === 'idle').length,
    offline: agents.filter((a) => a.status === 'offline').length,
  };

  const filtered = agents.filter((a) => {
    if (filter !== 'all' && a.status !== filter) return false;
    if (search === '') return true;
    const q = search.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      a.machine.toLowerCase().includes(q) ||
      a.department.toLowerCase().includes(q)
    );
  });

  const FILTERS: { label: string; value: Filter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Online', value: 'online' },
    { label: 'Idle', value: 'idle' },
    { label: 'Offline', value: 'offline' },
  ];

  return (
    <Panel
      title="Agents"
      flush
      index={index}
      action={
        <div className="flex items-center gap-2">
          <div className="seg hidden sm:inline-flex">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`seg-btn ${filter === f.value ? 'is-on' : ''}`}
              >
                {f.label}
                <span className="t3"> {counts[f.value]}</span>
              </button>
            ))}
          </div>
          <span className="field">
            <i className="ri-search-line text-[11.5px] t3" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              className="bg-transparent text-[11px] focus:outline-none w-20 md:w-28"
            />
          </span>
          <button onClick={() => navigate('/agents')} className="chip chip-quiet text-[9.5px]">
            All
            <i className="ri-arrow-right-line" />
          </button>
        </div>
      }
    >
      <div className="overflow-x-auto">
        <table className="d-table min-w-[820px]">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Machine</th>
              <th>Status</th>
              <th>Productivity</th>
              <th>Active today</th>
              <th>Presence · 24h</th>
              <th>Recent apps</th>
              <th style={{ width: 40 }}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((agent) => {
              const st = STATUS[agent.status] ?? STATUS.offline;
              return (
                <tr key={agent.id} onClick={() => navigate(`/agents/${agent.id}`)}>
                  <td className="whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="avatar">{agent.name.charAt(0).toUpperCase()}</span>
                      <span className="min-w-0">
                        <span className="block text-[11.5px] t1 font-medium leading-tight">
                          {agent.name}
                        </span>
                        <span className="block text-[9.5px] t3 mt-0.5">{agent.department}</span>
                      </span>
                    </div>
                  </td>

                  <td className="whitespace-nowrap">
                    <span className="flex items-center gap-2">
                      <i className={`${OS_ICON(agent.os)} text-[14px] t3`} />
                      <span className="min-w-0">
                        <span className="block text-[11.5px] t2 leading-tight">{agent.machine}</span>
                        <span className="block text-[9.5px] t3 mt-0.5">{agent.ipAddress}</span>
                      </span>
                    </span>
                  </td>

                  <td className="whitespace-nowrap">
                    <span className={`inline-flex items-center gap-2 text-[11px] ${st.cls}`}>
                      <span
                        className={`live-dot ${agent.status === 'online' ? '' : 'is-off'}`}
                        style={
                          agent.status === 'idle' ? { background: 'var(--d-warning)' } : undefined
                        }
                      />
                      {agent.seatLocked ? 'Seat locked' : st.label}
                    </span>
                  </td>

                  <td style={{ width: 108 }}>
                    {agent.productivity === null ? (
                      <span className="text-[11px] t3">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="block w-12">
                          <Bar
                            pct={agent.productivity}
                            height={4}
                            color={
                              agent.productivity >= 80
                                ? C.success
                                : agent.productivity >= 55
                                  ? C.accent
                                  : C.warning
                            }
                          />
                        </span>
                        <span className="text-[11px] t2 tnum">{agent.productivity}%</span>
                      </div>
                    )}
                  </td>

                  <td className="whitespace-nowrap">
                    <span className="block text-[11.5px] t2 leading-tight tnum">
                      {formatHm(agent.activeSeconds)}
                    </span>
                    <span className="block text-[9.5px] t3 mt-0.5">
                      idle {formatIdle(agent.idleSeconds)}
                    </span>
                  </td>

                  <td>
                    <PresenceStrip hours={hourlyByAgent[agent.id] ?? {}} />
                  </td>

                  <td>
                    <div className="flex flex-wrap gap-1 max-w-[180px]">
                      {agent.applications.length === 0 ? (
                        <span className="text-[11px] t3">—</span>
                      ) : (
                        <>
                          {agent.applications.slice(0, 2).map((app) => (
                            <span key={app} className="chip chip-quiet text-[9.5px] px-2 py-0.5">
                              {app}
                            </span>
                          ))}
                          {agent.applications.length > 2 && (
                            <span className="text-[9.5px] t3 self-center">
                              +{agent.applications.length - 2}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </td>

                  <td className="text-right relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(menuFor === agent.id ? null : agent.id);
                      }}
                      className="icon-btn"
                      aria-label={`Actions for ${agent.name}`}
                    >
                      <i className="ri-more-2-fill text-[12px]" />
                    </button>
                    {menuFor === agent.id && (
                      <div className="menu" onClick={(e) => e.stopPropagation()}>
                        {[
                          {
                            label: 'View details',
                            icon: 'ri-user-search-line',
                            to: `/agents/${agent.id}`,
                          },
                          { label: 'Live monitoring', icon: 'ri-computer-line', to: '/monitoring' },
                          {
                            label: 'System health',
                            icon: 'ri-heart-pulse-line',
                            to: '/system-health',
                          },
                        ].map((item) => (
                          <button
                            key={item.label}
                            onClick={() => {
                              setMenuFor(null);
                              navigate(item.to);
                            }}
                          >
                            <i className={item.icon} /> {item.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {!loading && agents.length === 0 && (
          <div className="px-4 py-9 text-center">
            <p className="text-[11.5px] t2 mb-1">No agents enrolled yet</p>
            <p className="text-[10.5px] t3 mb-3.5">
              Install the desktop agent on employee machines using your licence key.
            </p>
            <button onClick={() => navigate('/setup')} className="chip chip-solid">
              <i className="ri-add-line" />
              Go to agent setup
            </button>
          </div>
        )}
        {!loading && agents.length > 0 && filtered.length === 0 && (
          <div className="px-4 py-7 text-center text-[11px] t3">
            No agents match your search or filter.
          </div>
        )}
        {loading && agents.length === 0 && (
          <div className="px-4 py-9 text-center text-[11px] t3">Loading agents…</div>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="px-3 py-2 hair-t flex items-center justify-between">
          <span className="text-[9.5px] t3">
            {filtered.length} of {agents.length} agents
          </span>
          <span className="flex items-center gap-2 text-[9.5px] t3">
            quieter
            <span className="pres">
              {[0.3, 0.55, 0.8, 1].map((t) => (
                <span key={t}>
                  <i style={{ opacity: t }} />
                </span>
              ))}
            </span>
            busier
          </span>
        </div>
      )}
    </Panel>
  );
}
