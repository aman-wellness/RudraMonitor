import { useState, useMemo } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import {
  useAgents,
  useLatestSystemMetrics,
  useProductivityPerAgent,
  useOrgProductivityDaily,
} from '@/lib/dataHooks';

type ReportTab = 'productivity' | 'activity' | 'system' | 'time';
type ExportFormat = 'csv' | 'excel' | 'pdf';

const tabs: { id: ReportTab; label: string; icon: string }[] = [
  { id: 'productivity', label: 'Productivity', icon: 'ri-bar-chart-grouped-line' },
  { id: 'activity', label: 'Activity', icon: 'ri-pulse-line' },
  { id: 'system', label: 'System Health', icon: 'ri-heart-pulse-line' },
  { id: 'time', label: 'Time Reports', icon: 'ri-time-line' },
];

const departments = ['All', 'Development', 'HR', 'Finance', 'Design', 'Sales', 'Support', 'Marketing', 'Unassigned'];

const formatHours = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
};

type ReportAgent = {
  id: string;
  name: string;
  machine: string;
  department: string;
  status: 'online' | 'idle' | 'offline';
  os: string;
  productivity: number;
  activeHoursSec: number;
  activeHours: string;
  idleTime: string;
};

export default function ReportsPage() {
  const { agents: dbAgents } = useAgents();
  const { byAgent: perAgent } = useProductivityPerAgent(24);
  const { byAgent: latestMetrics } = useLatestSystemMetrics();
  const { rows: dailyRows } = useOrgProductivityDaily(7);

  // All per-agent aggregates come from a single RPC call; each table just maps over them.
  const { agents, systemData, timeData, activityCounts, weeklyProductivity } = useMemo(() => {
    const out: ReportAgent[] = [];
    const sysOut: Record<string, { cpu: number; memory: number; disk: number; uptime: string }> = {};
    const timeOut: Record<string, { login: string; logout: string; session: string; breaks: string }> = {};
    const actOut: Record<string, { appSwitches: number; browserEvents: number; screenshots: number; videos: number; alerts: number }> = {};

    for (const a of dbAgents) {
      const agg = perAgent[a.id];
      const activeSec = agg?.active_seconds ?? 0;
      const idleSec = agg?.idle_seconds ?? 0;

      out.push({
        id: a.id,
        name: a.name,
        machine: a.machine,
        department: a.department,
        status: a.status,
        os: a.os,
        productivity: agg?.productivity_pct ?? 0,
        activeHoursSec: activeSec,
        activeHours: formatHours(activeSec),
        idleTime: formatHours(idleSec),
      });

      const m = latestMetrics[a.id];
      sysOut[a.id] = {
        cpu: m?.cpu_usage ?? 0,
        memory: m?.ram_usage ?? 0,
        disk: m?.disk_usage ?? 0,
        uptime: m ? '—' : 'Offline',
      };

      // Login/logout precise times need first/last activity_log timestamps. The aggregation RPC
      // doesn't surface those — leaving as derived totals; wire a dedicated RPC later if needed.
      timeOut[a.id] = {
        login: '—',
        logout: a.status === 'online' ? '—' : '—',
        session: formatHours(activeSec + idleSec),
        breaks: formatHours(idleSec),
      };

      actOut[a.id] = {
        appSwitches: agg?.app_switches ?? 0,
        browserEvents: agg?.browser_events ?? 0,
        screenshots: agg?.screenshots ?? 0,
        videos: 0,
        alerts: agg?.alerts_count ?? 0,
      };
    }

    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const buckets = dailyRows.map((r) => ({
      day: DAYS[new Date(r.day_bucket + 'T00:00:00Z').getUTCDay()] ?? '',
      productivity: r.productivity_pct,
      agents: r.active_agents,
    }));

    return { agents: out, systemData: sysOut, timeData: timeOut, activityCounts: actOut, weeklyProductivity: buckets };
  }, [dbAgents, perAgent, latestMetrics, dailyRows]);
  const [activeTab, setActiveTab] = useState<ReportTab>('productivity');
  const [deptFilter, setDeptFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState('today');
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => {
      const matchesDept = deptFilter === 'All' || a.department === deptFilter;
      const matchesStatus = statusFilter === 'All' || a.status === statusFilter;
      const matchesSearch =
        search === '' ||
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.machine.toLowerCase().includes(search.toLowerCase());
      return matchesDept && matchesStatus && matchesSearch;
    });
  }, [agents, deptFilter, statusFilter, search]);

  /* ─── export helpers ─── */

  const buildCSV = (tab: ReportTab, data: typeof agents) => {
    let headers: string[] = [];
    let rows: string[][] = [];

    switch (tab) {
      case 'productivity':
        headers = ['Agent Name', 'Department', 'Machine', 'Status', 'Productivity %', 'Active Hours', 'Idle Time', 'Efficiency Score'];
        rows = data.map((a) => [
          a.name,
          a.department,
          a.machine,
          a.status,
          String(a.productivity),
          a.activeHours,
          a.idleTime,
          String(Math.round(a.productivity * 0.9)),
        ]);
        break;
      case 'activity':
        headers = ['Agent Name', 'Department', 'App Switches', 'Browser Events', 'Screenshots', 'Videos', 'Alerts', 'Total Events'];
        rows = data.map((a) => {
          const c = activityCounts[a.id] || { appSwitches: 0, browserEvents: 0, screenshots: 0, videos: 0, alerts: 0 };
          return [
            a.name,
            a.department,
            String(c.appSwitches),
            String(c.browserEvents),
            String(c.screenshots),
            String(c.videos),
            String(c.alerts),
            String(c.appSwitches + c.browserEvents + c.screenshots + c.videos + c.alerts),
          ];
        });
        break;
      case 'system':
        headers = ['Agent Name', 'Department', 'Machine', 'OS', 'CPU %', 'Memory %', 'Disk %', 'Uptime'];
        rows = data.map((a) => {
          const s = systemData[a.id] || { cpu: 0, memory: 0, disk: 0, uptime: 'N/A' };
          return [a.name, a.department, a.machine, a.os, String(s.cpu), String(s.memory), String(s.disk), s.uptime];
        });
        break;
      case 'time':
        headers = ['Agent Name', 'Department', 'Login Time', 'Logout Time', 'Total Session', 'Break Duration'];
        rows = data.map((a) => {
          const t = timeData[a.id] || { login: '-', logout: '-', session: '-', breaks: '-' };
          return [a.name, a.department, t.login, t.logout, t.session, t.breaks];
        });
        break;
    }

    const csv = [headers.join(','), ...rows.map((r) => r.map((cell) => `"${cell}"`).join(','))].join('\n');
    return csv;
  };

  const downloadFile = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExport = async (format: ExportFormat) => {
    setExporting(format);
    await new Promise((r) => setTimeout(r, 1200));

    const dateStr = new Date().toISOString().split('T')[0];
    const tabName = activeTab;
    const filename = `Rudrans_${tabName}_report_${dateStr}`;

    switch (format) {
      case 'csv': {
        const csv = buildCSV(activeTab, filteredAgents);
        downloadFile(csv, `${filename}.csv`, 'text/csv;charset=utf-8;');
        break;
      }
      case 'excel': {
        const csv = '\uFEFF' + buildCSV(activeTab, filteredAgents);
        downloadFile(csv, `${filename}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        break;
      }
      case 'pdf': {
        const csv = buildCSV(activeTab, filteredAgents);
        downloadFile(csv, `${filename}.pdf`, 'application/pdf');
        break;
      }
    }

    setExporting(null);
  };

  /* ─── summary cards ─── */
  const summaryCards = useMemo(() => {
    switch (activeTab) {
      case 'productivity':
        return [
          { label: 'Avg Productivity', value: `${Math.round(filteredAgents.reduce((s, a) => s + a.productivity, 0) / (filteredAgents.length || 1))}%`, icon: 'ri-bar-chart-grouped-line', color: 'emerald' },
          { label: 'Total Active Hours', value: `${filteredAgents.reduce((s, a) => s + parseInt(a.activeHours), 0)}h`, icon: 'ri-time-line', color: 'teal' },
          { label: 'High Performers', value: String(filteredAgents.filter((a) => a.productivity >= 80).length), icon: 'ri-trophy-line', color: 'amber' },
          { label: 'Agents Tracked', value: String(filteredAgents.length), icon: 'ri-team-line', color: 'violet' },
        ];
      case 'activity':
        return [
          { label: 'Total Events', value: String(filteredAgents.reduce((s, a) => {
            const c = activityCounts[a.id] || { appSwitches: 0, browserEvents: 0, screenshots: 0, videos: 0, alerts: 0 };
            return s + c.appSwitches + c.browserEvents + c.screenshots + c.videos + c.alerts;
          }, 0)), icon: 'ri-pulse-line', color: 'emerald' },
          { label: 'Screenshots', value: String(filteredAgents.reduce((s, a) => s + (activityCounts[a.id]?.screenshots || 0), 0)), icon: 'ri-image-line', color: 'teal' },
          { label: 'Videos', value: String(filteredAgents.reduce((s, a) => s + (activityCounts[a.id]?.videos || 0), 0)), icon: 'ri-video-line', color: 'amber' },
          { label: 'Alerts', value: String(filteredAgents.reduce((s, a) => s + (activityCounts[a.id]?.alerts || 0), 0)), icon: 'ri-notification-3-line', color: 'red' },
        ];
      case 'system':
        return [
          { label: 'Avg CPU', value: `${Math.round(filteredAgents.reduce((s, a) => s + (systemData[a.id]?.cpu || 0), 0) / (filteredAgents.filter((a) => systemData[a.id]?.cpu > 0).length || 1))}%`, icon: 'ri-cpu-line', color: 'emerald' },
          { label: 'High CPU Agents', value: String(filteredAgents.filter((a) => (systemData[a.id]?.cpu || 0) > 70).length), icon: 'ri-fire-line', color: 'red' },
          { label: 'Avg Memory', value: `${Math.round(filteredAgents.reduce((s, a) => s + (systemData[a.id]?.memory || 0), 0) / (filteredAgents.filter((a) => systemData[a.id]?.memory > 0).length || 1))}%`, icon: 'ri-database-2-line', color: 'teal' },
          { label: 'Online', value: String(filteredAgents.filter((a) => a.status === 'online').length), icon: 'ri-wifi-line', color: 'violet' },
        ];
      case 'time':
        return [
          { label: 'Total Sessions', value: `${filteredAgents.reduce((s, a) => s + parseInt((timeData[a.id]?.session || '0h')), 0)}h`, icon: 'ri-time-line', color: 'emerald' },
          { label: 'Avg Session', value: `${Math.round(filteredAgents.reduce((s, a) => s + parseInt((timeData[a.id]?.session || '0h')), 0) / (filteredAgents.length || 1))}h`, icon: 'ri-hourglass-line', color: 'teal' },
          { label: 'Break Time', value: `${filteredAgents.reduce((s, a) => {
            const b = timeData[a.id]?.breaks || '0m';
            return s + parseInt(b);
          }, 0)}m`, icon: 'ri-pause-line', color: 'amber' },
          { label: 'Active Today', value: String(filteredAgents.filter((a) => a.status !== 'offline').length), icon: 'ri-user-follow-line', color: 'violet' },
        ];
    }
  }, [activeTab, filteredAgents]);

  const getColorClasses = (color: string) => {
    const map: Record<string, { bg: string; text: string }> = {
      emerald: { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
      teal: { bg: 'bg-teal-500/10', text: 'text-teal-400' },
      amber: { bg: 'bg-amber-500/10', text: 'text-amber-400' },
      red: { bg: 'bg-red-500/10', text: 'text-red-400' },
      violet: { bg: 'bg-violet-500/10', text: 'text-violet-400' },
    };
    return map[color] || map.emerald;
  };

  const getOSIcon = (os: string) => {
    if (os.includes('Windows')) return 'ri-windows-fill text-blue-400';
    if (os.includes('macOS')) return 'ri-apple-fill text-gray-300';
    return 'ri-ubuntu-fill text-orange-400';
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
          <span className="text-white font-medium">Reports</span>
        </div>

        {/* Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-poppins font-bold text-white mb-1">Reports</h1>
            <p className="text-sm text-gray-500">
              {filteredAgents.length} agents · {dateRange === 'today' ? 'Today' : dateRange === 'week' ? 'This Week' : 'This Month'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleExport('csv')}
              disabled={!!exporting}
              className="px-3 py-2 rounded-lg bg-dark-800 text-gray-300 text-xs font-medium border border-dark-700 hover:bg-dark-700 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              {exporting === 'csv' ? (
                <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-loader-4-line animate-spin text-xs" /></span>
              ) : (
                <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-file-text-line text-xs" /></span>
              )}
              CSV
            </button>
            <button
              onClick={() => handleExport('excel')}
              disabled={!!exporting}
              className="px-3 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              {exporting === 'excel' ? (
                <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-loader-4-line animate-spin text-xs" /></span>
              ) : (
                <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-file-excel-line text-xs" /></span>
              )}
              Excel
            </button>
            <button
              onClick={() => handleExport('pdf')}
              disabled={!!exporting}
              className="px-3 py-2 rounded-lg bg-red-500/15 text-red-400 text-xs font-medium border border-red-500/25 hover:bg-red-500/25 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              {exporting === 'pdf' ? (
                <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-loader-4-line animate-spin text-xs" /></span>
              ) : (
                <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-file-pdf-line text-xs" /></span>
              )}
              PDF
            </button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          {summaryCards.map((card) => {
            const color = getColorClasses(card.color);
            return (
              <div key={card.label} className="bg-dark-800 border border-dark-700 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-8 h-8 rounded-lg ${color.bg} flex items-center justify-center`}>
                    <span className="w-4 h-4 flex items-center justify-center"><i className={`${card.icon} ${color.text} text-sm`} /></span>
                  </span>
                </div>
                <p className="text-lg md:text-xl font-poppins font-bold text-white">{card.value}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{card.label}</p>
              </div>
            );
          })}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
                activeTab === tab.id ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <span className="w-4 h-4 flex items-center justify-center"><i className={`${tab.icon} text-sm`} /></span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
          <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 w-full sm:w-auto sm:min-w-[240px]">
            <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
              <i className="ri-search-line text-sm" />
            </span>
            <input
              type="text"
              placeholder="Search agents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none w-full"
            />
          </div>
          <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1 overflow-x-auto">
            {departments.map((d) => (
              <button
                key={d}
                onClick={() => setDeptFilter(d)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
                  deptFilter === d ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1">
            {['All', 'online', 'idle', 'offline'].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap capitalize transition-all ${
                  statusFilter === s ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {s === 'All' ? 'All Status' : s}
              </button>
            ))}
          </div>
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-xs text-gray-300 focus:outline-none"
          >
            <option value="today">Today</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
            <option value="custom">Custom Range</option>
          </select>
        </div>

        {/* ─── PRODUCTIVITY TABLE ─── */}
        {activeTab === 'productivity' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Agent</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Department</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Status</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Productivity</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Active Hours</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Idle Time</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Efficiency</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map((agent) => (
                    <tr key={agent.id} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                            <span className="text-xs text-violet-400 font-semibold">{agent.name.charAt(0)}</span>
                          </div>
                          <div>
                            <p className="text-sm text-white font-medium">{agent.name}</p>
                            <p className="text-xs text-gray-500">{agent.machine}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-dark-900 text-gray-400 border border-dark-700">
                          {agent.department}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          agent.status === 'online' ? 'bg-emerald-500/15 text-emerald-400' :
                          agent.status === 'idle' ? 'bg-amber-500/15 text-amber-400' :
                          'bg-red-500/15 text-red-400'
                        }`}>
                          {agent.status === 'online' ? 'Active' : agent.status === 'idle' ? 'Idle' : 'Offline'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-2 bg-dark-700 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${
                              agent.productivity >= 80 ? 'bg-emerald-500' :
                              agent.productivity >= 60 ? 'bg-amber-500' : 'bg-red-500'
                            }`} style={{ width: `${agent.productivity}%` }} />
                          </div>
                          <span className="text-xs text-gray-300 font-medium">{agent.productivity}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-300">{agent.activeHours}</td>
                      <td className="px-4 py-3 text-sm text-gray-300">{agent.idleTime}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium ${
                          agent.productivity >= 80 ? 'text-emerald-400' :
                          agent.productivity >= 60 ? 'text-amber-400' : 'text-red-400'
                        }`}>
                          {Math.round(agent.productivity * 0.9)}%
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <span className="w-3 h-3 flex items-center justify-center"><i className="ri-arrow-up-line" /></span>
                          +{Math.floor(Math.random() * 8) + 1}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredAgents.length === 0 && (
              <div className="p-12 text-center">
                <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
                  <i className="ri-search-2-line text-3xl" />
                </span>
                <p className="text-sm text-gray-500">No agents match your filters</p>
              </div>
            )}
          </div>
        )}

        {/* ─── ACTIVITY TABLE ─── */}
        {activeTab === 'activity' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Agent</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Department</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">App Switches</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Browser Events</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Screenshots</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Videos</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Alerts</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map((agent) => {
                    const c = activityCounts[agent.id] || { appSwitches: 0, browserEvents: 0, screenshots: 0, videos: 0, alerts: 0 };
                    const total = c.appSwitches + c.browserEvents + c.screenshots + c.videos + c.alerts;
                    return (
                      <tr key={agent.id} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                              <span className="text-xs text-violet-400 font-semibold">{agent.name.charAt(0)}</span>
                            </div>
                            <div>
                              <p className="text-sm text-white font-medium">{agent.name}</p>
                              <p className="text-xs text-gray-500">{agent.machine}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-dark-900 text-gray-400 border border-dark-700">
                            {agent.department}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{c.appSwitches}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{c.browserEvents}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{c.screenshots}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{c.videos}</td>
                        <td className="px-4 py-3">
                          <span className={`text-sm font-medium ${c.alerts > 0 ? 'text-red-400' : 'text-gray-300'}`}>
                            {c.alerts}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-sm font-bold text-white">{total}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredAgents.length === 0 && (
              <div className="p-12 text-center">
                <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
                  <i className="ri-search-2-line text-3xl" />
                </span>
                <p className="text-sm text-gray-500">No agents match your filters</p>
              </div>
            )}
          </div>
        )}

        {/* ─── SYSTEM HEALTH TABLE ─── */}
        {activeTab === 'system' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Agent</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Machine</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">OS</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">CPU Usage</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Memory</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Disk</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Uptime</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map((agent) => {
                    const s = systemData[agent.id] || { cpu: 0, memory: 0, disk: 0, uptime: 'N/A' };
                    const avg = (s.cpu + s.memory + s.disk) / 3;
                    const health = avg > 75 ? 'Critical' : avg > 50 ? 'Warning' : 'Good';
                    return (
                      <tr key={agent.id} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                              <span className="text-xs text-violet-400 font-semibold">{agent.name.charAt(0)}</span>
                            </div>
                            <div>
                              <p className="text-sm text-white font-medium">{agent.name}</p>
                              <p className="text-xs text-gray-500">{agent.department}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{agent.machine}</td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1.5 text-xs text-gray-400">
                            <span className="w-4 h-4 flex items-center justify-center"><i className={`${getOSIcon(agent.os)} text-sm`} /></span>
                            {agent.os}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 bg-dark-700 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${s.cpu > 70 ? 'bg-red-500' : s.cpu > 40 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${s.cpu}%` }} />
                            </div>
                            <span className="text-xs text-gray-300">{s.cpu}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 bg-dark-700 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${s.memory > 70 ? 'bg-red-500' : s.memory > 40 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${s.memory}%` }} />
                            </div>
                            <span className="text-xs text-gray-300">{s.memory}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 bg-dark-700 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${s.disk > 80 ? 'bg-red-500' : s.disk > 50 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${s.disk}%` }} />
                            </div>
                            <span className="text-xs text-gray-300">{s.disk}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{s.uptime}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            health === 'Good' ? 'bg-emerald-500/15 text-emerald-400' :
                            health === 'Warning' ? 'bg-amber-500/15 text-amber-400' :
                            'bg-red-500/15 text-red-400'
                          }`}>
                            {health}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredAgents.length === 0 && (
              <div className="p-12 text-center">
                <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
                  <i className="ri-search-2-line text-3xl" />
                </span>
                <p className="text-sm text-gray-500">No agents match your filters</p>
              </div>
            )}
          </div>
        )}

        {/* ─── TIME REPORTS TABLE ─── */}
        {activeTab === 'time' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px]">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Agent</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Department</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Login Time</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Logout Time</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Total Session</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Break Duration</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map((agent) => {
                    const t = timeData[agent.id] || { login: '-', logout: '-', session: '-', breaks: '-' };
                    const sessionMins = parseInt(t.session) || 0;
                    const breakMins = parseInt(t.breaks) || 0;
                    const util = sessionMins > 0 ? Math.round(((sessionMins - breakMins) / sessionMins) * 100) : 0;
                    return (
                      <tr key={agent.id} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                              <span className="text-xs text-violet-400 font-semibold">{agent.name.charAt(0)}</span>
                            </div>
                            <div>
                              <p className="text-sm text-white font-medium">{agent.name}</p>
                              <p className="text-xs text-gray-500">{agent.machine}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-dark-900 text-gray-400 border border-dark-700">
                            {agent.department}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{t.login}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{t.logout}</td>
                        <td className="px-4 py-3 text-sm text-white font-medium">{t.session}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{t.breaks}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-2 bg-dark-700 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${util >= 80 ? 'bg-emerald-500' : util >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${util}%` }} />
                            </div>
                            <span className="text-xs text-gray-300 font-medium">{util}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredAgents.length === 0 && (
              <div className="p-12 text-center">
                <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
                  <i className="ri-search-2-line text-3xl" />
                </span>
                <p className="text-sm text-gray-500">No agents match your filters</p>
              </div>
            )}
          </div>
        )}

        {/* Weekly Chart mini visualization */}
        {activeTab === 'productivity' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white">Weekly Productivity Trend</h3>
              <span className="text-xs text-gray-500">Last 7 days</span>
            </div>
            <div className="flex items-end gap-2 md:gap-4 h-32">
              {weeklyProductivity.map((d) => (
                <div key={d.day} className="flex-1 flex flex-col items-center gap-1.5">
                  <div className="text-xs text-gray-500 mb-1">{d.productivity}%</div>
                  <div className="w-full bg-dark-700 rounded-t-md relative overflow-hidden" style={{ height: `${d.productivity}%`, maxHeight: '96px' }}>
                    <div className="absolute inset-0 bg-emerald-500/30 rounded-t-md" />
                  </div>
                  <span className="text-xs text-gray-400 font-medium">{d.day}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}