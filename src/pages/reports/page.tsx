import { useState, useMemo, useEffect } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import {
  useAgents,
  useLatestSystemMetrics,
  useProductivityPerAgent,
  useOrgProductivityDaily,
} from '@/lib/dataHooks';

// Departments rollup lives in Admin Portal → Departments tab.
// System Health has its own sidebar entry (Insights → System Health).
// Reports stays focused on the three report types managers actually
// export: productivity, activity volume, and time tracking.
type ReportTab = 'productivity' | 'activity' | 'time';
type ExportFormat = 'csv' | 'excel' | 'pdf';

const tabs: { id: ReportTab; label: string; icon: string; help: string }[] = [
  { id: 'productivity', label: 'Productivity', icon: 'ri-bar-chart-grouped-line', help: 'Per-agent productivity %, active hours, idle time. Top performers shown above.' },
  { id: 'activity',     label: 'Activity',     icon: 'ri-pulse-line',             help: 'How busy each agent has been — app switches, browser hits, screenshots captured.' },
  { id: 'time',         label: 'Time Tracking',icon: 'ri-time-line',              help: 'Session totals + idle breakdowns per agent. Use for billable-hour reports.' },
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
  // 'all' → export the current tab for every filtered agent (original
  // behavior). An agent id → export all THREE tabs' data for that ONE
  // agent into a single file — "complete per-agent report" customers
  // asked for on 2026-07-27.
  const [exportTarget, setExportTarget] = useState<string>('all');
  // If the currently-picked agent gets filtered out (search / dept /
  // status change), snap back to 'all' so the dropdown never shows a
  // stale selection that doesn't correspond to a listed agent.
  useEffect(() => {
    if (exportTarget === 'all') return;
    // Compute inline instead of depending on filteredAgents from below
    // (which isn't in scope yet) — same filter logic.
    const stillListed = agents.some((a) => {
      if (a.id !== exportTarget) return false;
      const matchesDept = deptFilter === 'All' || a.department === deptFilter;
      const matchesStatus = statusFilter === 'All' || a.status === statusFilter;
      const matchesSearch = search === '' ||
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.machine.toLowerCase().includes(search.toLowerCase());
      return matchesDept && matchesStatus && matchesSearch;
    });
    if (!stillListed) setExportTarget('all');
  }, [agents, exportTarget, deptFilter, statusFilter, search]);

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

  // Top performer card (Productivity tab). Picks the highest-productivity
  // agent with at least 30 min of activity — avoids "100% on 5 minutes of
  // signal" anomalies that would mislead managers.
  const topPerformer = useMemo(() => {
    const eligible = agents.filter((a) => a.activeHoursSec >= 30 * 60);
    if (eligible.length === 0) return null;
    return eligible.reduce((best, a) => (a.productivity > best.productivity ? a : best), eligible[0]);
  }, [agents]);

  /* ─── export helpers ─── */

  // Returns [headers, rows] for a tab so both CSV + PDF paths use the
  // exact same source arrays. Prior code duplicated headers/rows across
  // buildCSV and would have needed a parallel duplicate for the PDF
  // path — one struct keeps them in sync forever.
  const buildTabRows = (tab: ReportTab, data: typeof agents): { headers: string[]; rows: string[][] } => {
    switch (tab) {
      case 'productivity':
        return {
          headers: ['Agent Name', 'Department', 'Machine', 'Status', 'Productivity %', 'Active Hours', 'Idle Time', 'Efficiency Score'],
          rows: data.map((a) => [
            a.name,
            a.department,
            a.machine,
            a.status,
            String(a.productivity),
            a.activeHours,
            a.idleTime,
            String(Math.round(a.productivity * 0.9)),
          ]),
        };
      case 'activity':
        return {
          headers: ['Agent Name', 'Department', 'App Switches', 'Browser Events', 'Screenshots', 'Videos', 'Alerts', 'Total Events'],
          rows: data.map((a) => {
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
          }),
        };
      case 'time':
        return {
          headers: ['Agent Name', 'Department', 'Login Time', 'Logout Time', 'Total Session', 'Break Duration'],
          rows: data.map((a) => {
            const t = timeData[a.id] || { login: '-', logout: '-', session: '-', breaks: '-' };
            return [a.name, a.department, t.login, t.logout, t.session, t.breaks];
          }),
        };
    }
  };

  const buildCSV = (tab: ReportTab, data: typeof agents) => {
    const { headers, rows } = buildTabRows(tab, data);
    return [headers.join(','), ...rows.map((r) => r.map((cell) => `"${cell}"`).join(','))].join('\n');
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

  // Build the FULL per-agent report \u2014 every tab's data in one file,
  // sectioned with clear headers. Used when exportTarget !== 'all'.
  const buildAgentFullCSV = (agent: (typeof agents)[number]) => {
    const nameSafe = agent.name.replace(/"/g, '""');
    const header = [
      `"AGENT REPORT \u2014 ${nameSafe}"`,
      `"Department","${agent.department}"`,
      `"Machine","${agent.machine}"`,
      `"Status","${agent.status}"`,
      `"Window","${dateRange === 'today' ? 'Today' : dateRange === 'week' ? 'This Week' : 'This Month'}"`,
      `"Generated","${new Date().toISOString()}"`,
      '',
    ].join('\n');
    // Reuse buildCSV with a single-row slice so section formatting stays
    // consistent with the multi-agent export shape.
    const one = [agent];
    return [
      header,
      '"\u2014 Productivity \u2014"',
      buildCSV('productivity', one),
      '',
      '"\u2014 Activity \u2014"',
      buildCSV('activity', one),
      '',
      '"\u2014 Time Tracking \u2014"',
      buildCSV('time', one),
      '',
    ].join('\n');
  };

  // Render a real PDF via jspdf + autotable. Client-side, no server round
  // trip. Layout: title block on top (agent name / dept / machine / window /
  // generated timestamp), then one section per tab with a striped table.
  // For the multi-agent path, single section with the current tab's data.
  const buildPDF = async (): Promise<Blob> => {
    // Dynamic import so the ~150 KB jspdf bundle doesn't inflate the
    // main Reports page load \u2014 only paid when the user actually clicks
    // "PDF". Vite splits it into its own chunk.
    const [{ default: jsPDF }, autoTableModule] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const autoTable = (autoTableModule as { default: (doc: unknown, opts: unknown) => void }).default;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

    const singleAgent = exportTarget !== 'all'
      ? filteredAgents.find((a) => a.id === exportTarget) ?? null
      : null;

    const windowLabel = dateRange === 'today' ? 'Today' : dateRange === 'week' ? 'This Week' : 'This Month';
    const now = new Date().toLocaleString();

    // Title block. jspdf coords: (x, y) in points from the top-left.
    doc.setFontSize(16);
    doc.setTextColor(20, 20, 20);
    doc.text(
      singleAgent ? `Agent Report \u2014 ${singleAgent.name}` : 'Reports',
      40, 40,
    );
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    const meta: string[] = singleAgent
      ? [
          `Department: ${singleAgent.department}`,
          `Machine: ${singleAgent.machine}`,
          `Status: ${singleAgent.status}`,
          `Window: ${windowLabel}`,
          `Generated: ${now}`,
        ]
      : [
          `${filteredAgents.length} agent${filteredAgents.length === 1 ? '' : 's'}`,
          `Tab: ${activeTab}`,
          `Window: ${windowLabel}`,
          `Generated: ${now}`,
        ];
    doc.text(meta.join('   \u00B7   '), 40, 60);

    const tabs: ReportTab[] = singleAgent
      ? ['productivity', 'activity', 'time']
      : [activeTab];
    const dataSlice = singleAgent ? [singleAgent] : filteredAgents;

    // Track cursor y between sections so multi-tab PDFs flow naturally.
    let startY = 80;
    for (const tab of tabs) {
      const { headers, rows } = buildTabRows(tab, dataSlice);
      const label = tab === 'productivity' ? 'Productivity'
        : tab === 'activity' ? 'Activity'
        : 'Time Tracking';
      doc.setFontSize(11);
      doc.setTextColor(20, 20, 20);
      doc.text(label, 40, startY);
      autoTable(doc, {
        head: [headers],
        body: rows,
        startY: startY + 8,
        theme: 'striped',
        headStyles: { fillColor: [16, 185, 129], textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 8, textColor: 30 },
        margin: { left: 40, right: 40 },
        styles: { cellPadding: 4, overflow: 'linebreak' },
      });
      // autoTable extends the doc with a `lastAutoTable` bookkeeping
      // object holding the finalY coord after the table renders. Read
      // it to know where to place the NEXT section's heading without
      // overlapping the table above.
      const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? startY;
      startY = finalY + 30;
      // Page break if next section wouldn't fit above the footer band.
      if (startY > doc.internal.pageSize.getHeight() - 80) {
        doc.addPage();
        startY = 40;
      }
    }

    return doc.output('blob');
  };

  const handleExport = async (format: ExportFormat) => {
    setExporting(format);

    const dateStr = new Date().toISOString().split('T')[0];
    const singleAgent = exportTarget !== 'all'
      ? filteredAgents.find((a) => a.id === exportTarget) ?? null
      : null;

    const filename = singleAgent
      ? `Rudrans_${singleAgent.name.replace(/[^\w-]+/g, '_')}_full_report_${dateStr}`
      : `Rudrans_${activeTab}_report_${dateStr}`;

    try {
      if (format === 'pdf') {
        const blob = await buildPDF();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${filename}.pdf`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const csvBody = singleAgent
          ? buildAgentFullCSV(singleAgent)
          : buildCSV(activeTab, filteredAgents);
        if (format === 'csv') {
          downloadFile(csvBody, `${filename}.csv`, 'text/csv;charset=utf-8;');
        } else {
          // BOM prefix so Excel opens UTF-8 without garbling the header.
          downloadFile('\uFEFF' + csvBody, `${filename}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        }
      }
    } finally {
      setExporting(null);
    }
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
  }, [activeTab, filteredAgents, timeData, activityCounts]);

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
          <div className="flex items-center gap-2 flex-wrap">
            {/* Target selector — pick "All agents" for the current tab,
                or a single agent to export their full multi-tab report. */}
            <select
              value={exportTarget}
              onChange={(e) => setExportTarget(e.target.value)}
              disabled={!!exporting}
              title="Choose export target"
              className="px-3 py-2 rounded-lg bg-dark-800 text-gray-300 text-xs font-medium border border-dark-700 hover:bg-dark-700 transition-colors focus:outline-none disabled:opacity-50 max-w-[220px] truncate"
            >
              <option value="all">All agents ({filteredAgents.length})</option>
              {filteredAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.department ? ` · ${a.department}` : ''}</option>
              ))}
            </select>
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

        {/* Tab help line — one-line explanation of what THIS tab shows.
            Customers told us they didn't understand the difference between
            Performance and Reports; making each tab's purpose explicit at
            the top of the page is the cheapest possible fix. */}
        {(() => {
          const cur = tabs.find((t) => t.id === activeTab);
          return cur ? (
            <p className="text-xs text-gray-500 -mt-2 px-1">{cur.help}</p>
          ) : null;
        })()}

        {/* Top Performer hero (Productivity tab only). Pulls from agents
            with ≥30min activity so we don't crown someone who happened to
            hit 100% on 5 minutes of signal. */}
        {activeTab === 'productivity' && topPerformer && (
          <div className="bg-gradient-to-r from-emerald-500/15 to-teal-500/10 border border-emerald-500/25 rounded-xl p-4 flex items-center gap-4">
            <span className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center text-emerald-400">
              <i className="ri-trophy-line text-lg" />
            </span>
            <div className="flex-1">
              <p className="text-[11px] uppercase tracking-wider text-emerald-300/80 font-medium">Top performer today</p>
              <p className="text-sm text-white font-semibold mt-0.5">
                {topPerformer.name}
                <span className="text-gray-500 font-normal ml-2">· {topPerformer.department}</span>
              </p>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold text-emerald-400">{topPerformer.productivity}%</p>
              <p className="text-[11px] text-gray-500">{topPerformer.activeHours} active</p>
            </div>
          </div>
        )}

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