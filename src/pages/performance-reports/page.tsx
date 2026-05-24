import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAgents, useProductivityPerAgent, useOrgProductivityDaily } from '@/lib/dataHooks';

const perfTabs = ['Overview', 'Agents', 'Departments', 'Trends'] as const;
type PerfTab = (typeof perfTabs)[number];

const formatHours = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
};

type LegacyAgent = {
  id: string;
  name: string;
  department: string;
  status: 'online' | 'idle' | 'offline';
  productivity: number;
  activeHours: string;
  activeHoursSec: number;
};

export default function PerformanceReportsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<PerfTab>('Overview');
  const [dateRange, setDateRange] = useState('today');
  const [sortBy, setSortBy] = useState<'productivity' | 'hours' | 'name'>('productivity');

  const { agents: dbAgents } = useAgents();
  const sinceHours = dateRange === 'week' ? 24 * 7 : dateRange === 'month' ? 24 * 30 : dateRange === 'quarter' ? 24 * 90 : 24;
  const { byAgent: perAgent } = useProductivityPerAgent(sinceHours);

  const agents: LegacyAgent[] = useMemo(() => {
    return dbAgents.map((a) => {
      const agg = perAgent[a.id];
      const sec = agg?.active_seconds ?? 0;
      return {
        id: a.id,
        name: a.name,
        department: a.department,
        status: a.status,
        productivity: agg?.productivity_pct ?? 0,
        activeHours: formatHours(sec),
        activeHoursSec: sec,
      };
    });
  }, [dbAgents, perAgent]);

  const sortedAgents = [...agents].sort((a, b) => {
    if (sortBy === 'productivity') return b.productivity - a.productivity;
    if (sortBy === 'hours') return b.activeHoursSec - a.activeHoursSec;
    return a.name.localeCompare(b.name);
  });

  const topPerformer = agents.length > 0
    ? agents.reduce((best, a) => (a.productivity > best.productivity ? a : best), agents[0])
    : { name: '—' };
  const avgProd = agents.length > 0 ? Math.round(agents.reduce((s, a) => s + a.productivity, 0) / agents.length) : 0;
  const totalHoursStr = formatHours(agents.reduce((s, a) => s + a.activeHoursSec, 0));

  // Departments aggregation: group agents by department, average productivity, sum hours.
  const deptStats = useMemo(() => {
    const map = new Map<string, { name: string; agents: number; weightedProd: number; totalHoursSec: number }>();
    for (const a of agents) {
      const d = map.get(a.department) ?? { name: a.department, agents: 0, weightedProd: 0, totalHoursSec: 0 };
      d.agents += 1;
      d.weightedProd += a.productivity;
      d.totalHoursSec += a.activeHoursSec;
      map.set(a.department, d);
    }
    return Array.from(map.values()).map((d) => ({
      name: d.name,
      agents: d.agents,
      avgProductivity: d.agents > 0 ? Math.round(d.weightedProd / d.agents) : 0,
      totalHours: formatHours(d.totalHoursSec),
      trend: '0%',
    }));
  }, [agents]);

  // 7-day weekly buckets fetched server-side.
  const { rows: dailyRows } = useOrgProductivityDaily(7);
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weeklyProductivity = dailyRows.map((r) => ({
    day: DAY_NAMES[new Date(r.day_bucket + 'T00:00:00Z').getUTCDay()] ?? '',
    productivity: r.productivity_pct,
    agents: r.active_agents,
  }));

  // Hourly breakdown is no longer computed client-side — placeholder until a dedicated RPC ships.
  // Showing a fixed scaffold keeps the existing UI intact without paying a 5000-row download cost.
  const hourlyData = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((h) => ({
    hour: `${h % 12 || 12}${h < 12 ? 'AM' : 'PM'}`,
    active: 0,
    idle: 0,
    offline: 60,
  }));

  const getBarColor = (val: number) => {
    if (val >= 80) return 'bg-emerald-500';
    if (val >= 60) return 'bg-amber-500';
    return 'bg-red-500';
  };

  return (
    <DashboardLayout>
      <div className="space-y-5">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-dashboard-line" /></span>
            Dashboard
          </span>
          <i className="ri-arrow-right-s-line text-gray-600" />
          <span className="text-white font-medium">Performance</span>
        </div>

        {/* Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-poppins font-bold text-white mb-1">Performance Reports</h1>
            <p className="text-sm text-gray-500">Track productivity, efficiency and performance trends</p>
          </div>
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-xs text-gray-300 focus:outline-none"
          >
            <option value="today">Today</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
            <option value="quarter">This Quarter</option>
          </select>
        </div>

        {/* Overview Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          {[
            { label: 'Avg Productivity', value: `${avgProd}%`, icon: 'ri-bar-chart-grouped-line', color: 'emerald' },
            { label: 'Top Performer', value: (topPerformer.name?.split(' ')[0] ?? '—'), icon: 'ri-trophy-line', color: 'amber' },
            { label: 'Active Agents', value: String(agents.filter((a) => a.status === 'online').length), icon: 'ri-wifi-line', color: 'teal' },
            { label: 'Total Hours', value: totalHoursStr, icon: 'ri-time-line', color: 'violet' },
          ].map((s) => (
            <div key={s.label} className="bg-dark-800 border border-dark-700 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-8 h-8 rounded-lg bg-${s.color}-500/10 flex items-center justify-center`}>
                  <span className="w-4 h-4 flex items-center justify-center"><i className={`${s.icon} text-${s.color}-400 text-sm`} /></span>
                </span>
              </div>
              <p className="text-xl font-poppins font-bold text-white">{s.value}</p>
              <p className="text-[11px] text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1 overflow-x-auto">
          {perfTabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-md text-xs font-medium whitespace-nowrap transition-all ${tab === t ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* OVERVIEW */}
        {tab === 'Overview' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Weekly Productivity */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">Weekly Productivity</h3>
                <span className="text-xs text-gray-500">Last 7 days</span>
              </div>
              <div className="flex items-end gap-2 md:gap-4 h-36">
                {weeklyProductivity.map((d) => (
                  <div key={d.day} className="flex-1 flex flex-col items-center gap-1.5">
                    <div className="text-xs text-gray-400 font-medium">{d.productivity}%</div>
                    <div className="w-full bg-dark-700 rounded-t-md relative overflow-hidden" style={{ height: `${d.productivity * 0.8}px`, maxHeight: '100px' }}>
                      <div className="absolute inset-0 bg-emerald-500/40 rounded-t-md" />
                    </div>
                    <span className="text-xs text-gray-500">{d.day}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Hourly Activity */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">Hourly Activity</h3>
                <span className="text-xs text-gray-500">Today</span>
              </div>
              <div className="space-y-2">
                {hourlyData.map((h) => {
                  const total = h.active + h.idle + h.offline;
                  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
                  return (
                    <div key={h.hour} className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 w-8 text-right">{h.hour}</span>
                      <div className="flex-1 flex h-5 bg-dark-700 rounded overflow-hidden">
                        <div className="bg-emerald-500 h-full" style={{ width: `${pct(h.active)}%` }} />
                        <div className="bg-amber-500 h-full" style={{ width: `${pct(h.idle)}%` }} />
                        <div className="bg-red-500 h-full" style={{ width: `${pct(h.offline)}%` }} />
                      </div>
                      <span className="text-xs text-gray-400 w-6 text-right">{total}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-4 mt-3">
                <span className="flex items-center gap-1.5 text-[11px] text-gray-400"><span className="w-2 h-2 rounded-sm bg-emerald-500" />Active</span>
                <span className="flex items-center gap-1.5 text-[11px] text-gray-400"><span className="w-2 h-2 rounded-sm bg-amber-500" />Idle</span>
                <span className="flex items-center gap-1.5 text-[11px] text-gray-400"><span className="w-2 h-2 rounded-sm bg-red-500" />Offline</span>
              </div>
            </div>

            {/* Top 5 Performers */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 md:col-span-2">
              <h3 className="text-sm font-semibold text-white mb-4">Top Performers</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                {sortedAgents.slice(0, 5).map((a, i) => (
                  <div key={a.id} className="bg-dark-900 rounded-lg border border-dark-700 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                        <span className="text-xs text-violet-400 font-semibold">{a.name.charAt(0)}</span>
                      </div>
                      <span className="text-lg font-bold text-amber-400">#{i + 1}</span>
                    </div>
                    <p className="text-sm text-white font-medium">{a.name}</p>
                    <p className="text-[11px] text-gray-500 mb-3">{a.department}</p>
                    <div className="flex items-center gap-2">
                      <div className="w-full bg-dark-700 rounded-full h-2">
                        <div className={`h-2 rounded-full ${getBarColor(a.productivity)}`} style={{ width: `${a.productivity}%` }} />
                      </div>
                      <span className="text-xs text-white font-medium">{a.productivity}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* AGENTS TAB */}
        {tab === 'Agents' && (
          <div>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs text-gray-500">Sort by:</span>
              <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1">
                {(['productivity', 'hours', 'name'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSortBy(s)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-all ${sortBy === s ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px]">
                  <thead>
                    <tr className="border-b border-dark-700">
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Rank</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Agent</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Department</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Status</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Productivity</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Active Hours</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAgents.map((a, i) => (
                      <tr key={a.id} onClick={() => navigate(`/agents/${a.id}`)} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors cursor-pointer">
                        <td className="px-4 py-3">
                          <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${i < 3 ? 'bg-amber-500/20 text-amber-400' : 'bg-dark-700 text-gray-400'}`}>
                            {i + 1}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                              <span className="text-xs text-violet-400 font-semibold">{a.name.charAt(0)}</span>
                            </div>
                            <p className="text-sm text-white font-medium">{a.name}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-dark-900 text-gray-400 border border-dark-700">{a.department}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${a.status === 'online' ? 'bg-emerald-500/15 text-emerald-400' : a.status === 'idle' ? 'bg-amber-500/15 text-amber-400' : 'bg-red-500/15 text-red-400'}`}>
                            {a.status === 'online' ? 'Active' : a.status === 'idle' ? 'Idle' : 'Offline'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-20 bg-dark-700 rounded-full h-2">
                              <div className={`h-2 rounded-full ${getBarColor(a.productivity)}`} style={{ width: `${a.productivity}%` }} />
                            </div>
                            <span className="text-xs text-gray-300">{a.productivity}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{a.activeHours}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-bold ${a.productivity >= 80 ? 'text-emerald-400' : a.productivity >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
                            {Math.round(a.productivity * 0.95)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* DEPARTMENTS TAB */}
        {tab === 'Departments' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px]">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Department</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Agents</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Avg Productivity</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Total Hours</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Trend</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Performance</th>
                  </tr>
                </thead>
                <tbody>
                  {deptStats.sort((a, b) => b.avgProductivity - a.avgProductivity).map((d) => (
                    <tr key={d.name} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className="w-8 h-8 rounded-lg bg-dark-700 flex items-center justify-center">
                            <span className="w-4 h-4 flex items-center justify-center"><i className="ri-briefcase-line text-gray-400 text-sm" /></span>
                          </span>
                          <p className="text-sm text-white font-medium">{d.name}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-300">{d.agents}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-20 bg-dark-700 rounded-full h-2">
                            <div className={`h-2 rounded-full ${getBarColor(d.avgProductivity)}`} style={{ width: `${d.avgProductivity}%` }} />
                          </div>
                          <span className="text-xs text-gray-300">{d.avgProductivity}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-300">{d.totalHours}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium flex items-center gap-1 ${d.trend.startsWith('+') ? 'text-emerald-400' : d.trend === '0%' ? 'text-gray-400' : 'text-red-400'}`}>
                          <span className="w-3 h-3 flex items-center justify-center"><i className={d.trend.startsWith('+') ? 'ri-arrow-up-line' : d.trend === '0%' ? 'ri-subtract-line' : 'ri-arrow-down-line'} /></span>
                          {d.trend}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${d.avgProductivity >= 80 ? 'bg-emerald-500/15 text-emerald-400' : d.avgProductivity >= 50 ? 'bg-amber-500/15 text-amber-400' : 'bg-red-500/15 text-red-400'}`}>
                          {d.avgProductivity >= 80 ? 'Excellent' : d.avgProductivity >= 50 ? 'Good' : 'Needs Work'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TRENDS TAB */}
        {tab === 'Trends' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Productivity Trend (Weekly)</h3>
              <div className="space-y-3">
                {weeklyProductivity.map((d) => (
                  <div key={d.day}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-400">{d.day}</span>
                      <span className="text-xs text-gray-300">{d.productivity}%</span>
                    </div>
                    <div className="w-full bg-dark-700 rounded-full h-3">
                      <div className={`h-3 rounded-full ${getBarColor(d.productivity)}`} style={{ width: `${d.productivity}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Agent Count Trend</h3>
              <div className="space-y-3">
                {weeklyProductivity.map((d) => (
                  <div key={d.day}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-400">{d.day}</span>
                      <span className="text-xs text-gray-300">{d.agents} agents</span>
                    </div>
                    <div className="w-full bg-dark-700 rounded-full h-3">
                      <div className="bg-teal-500 h-3 rounded-full" style={{ width: `${(d.agents / 30) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 md:col-span-2">
              <h3 className="text-sm font-semibold text-white mb-4">Daily Activity Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'Most Active Hour', value: '11:00 AM', icon: 'ri-sun-line', color: 'amber' },
                  { label: 'Least Active Hour', value: '1:00 PM', icon: 'ri-moon-line', color: 'violet' },
                  { label: 'Avg Session', value: '7h 15m', icon: 'ri-time-line', color: 'emerald' },
                  { label: 'Peak Agents', value: '22 agents', icon: 'ri-team-line', color: 'teal' },
                ].map((item) => (
                  <div key={item.label} className="bg-dark-900 rounded-lg border border-dark-700 p-4">
                    <span className="w-8 h-8 rounded-lg bg-dark-700 flex items-center justify-center mb-2">
                      <span className="w-4 h-4 flex items-center justify-center"><i className={`${item.icon} text-${item.color}-400 text-sm`} /></span>
                    </span>
                    <p className="text-sm font-bold text-white">{item.value}</p>
                    <p className="text-[11px] text-gray-500">{item.label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}