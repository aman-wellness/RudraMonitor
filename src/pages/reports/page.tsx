import { useState, useMemo, useEffect, useRef } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import Breadcrumb from '@/components/Breadcrumb';
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

/* Tallest a trend bar can draw. The strip is h-32 (128px) and the labels above
   and below each bar take the rest — a percentage height can't be used here,
   see the comment at the bar itself. */
const BAR_MAX_PX = 88;

const tabs: { id: ReportTab; label: string; icon: string; help: string }[] = [
  { id: 'productivity', label: 'Productivity', icon: 'ri-bar-chart-grouped-line', help: 'Per-agent productivity %, active hours, idle time. Top performers shown above.' },
  { id: 'activity',     label: 'Activity',     icon: 'ri-pulse-line',             help: 'How busy each agent has been — app switches, browser hits, screenshots captured.' },
  { id: 'time',         label: 'Time Tracking',icon: 'ri-time-line',              help: 'Session totals + idle breakdowns per agent. Use for billable-hour reports.' },
];

const formatHours = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
};

// Header "select all" checkbox. `indeterminate` can only be set via the
// DOM property (there's no React prop for it), so we thread it through a ref.
function SelectAllCheckbox({
  checked,
  indeterminate,
  onChange,
  title,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      title={title}
      className="w-3.5 h-3.5 rounded border-dark-600 bg-dark-900 text-emerald-500 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-emerald-500"
    />
  );
}

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
  // Date-range selector. Declared before the data hooks so the chosen
  // window can drive the per-agent productivity lookback.
  const [dateRange, setDateRange] = useState('today');
  const [customFrom, setCustomFrom] = useState(''); // yyyy-mm-dd, "Custom Range" start
  const [customTo, setCustomTo] = useState('');     // yyyy-mm-dd, "Custom Range" end
  // Both bounds are expressed as "hours ago" so the productivity hook can
  // build since = now - rangeHours and until = now - rangeUntilHours.
  const { rangeHours, rangeUntilHours } = useMemo(() => {
    if (dateRange === 'week') return { rangeHours: 24 * 7, rangeUntilHours: 0 };
    if (dateRange === 'month') return { rangeHours: 24 * 30, rangeUntilHours: 0 };
    if (dateRange === 'custom') {
      const now = Date.now();
      const sinceMs = customFrom ? now - new Date(customFrom + 'T00:00:00').getTime() : 24 * 3_600_000;
      // Include the whole "to" day (end at 23:59:59). If it's today or in
      // the future the diff goes ≤0 → clamps to 0 → "up to now".
      const untilMs = customTo ? now - new Date(customTo + 'T23:59:59').getTime() : 0;
      return {
        rangeHours: Math.max(1, Math.ceil(sinceMs / 3_600_000)),
        rangeUntilHours: Math.max(0, Math.floor(untilMs / 3_600_000)),
      };
    }
    return { rangeHours: 24, rangeUntilHours: 0 }; // today
  }, [dateRange, customFrom, customTo]);
  const rangeLabel =
    dateRange === 'today' ? 'Today'
    : dateRange === 'week' ? 'This Week'
    : dateRange === 'month' ? 'This Month'
    : (customFrom || customTo) ? `${customFrom || '…'} → ${customTo || 'today'}` : 'Custom Range';

  const { agents: dbAgents } = useAgents();
  const { byAgent: perAgent } = useProductivityPerAgent(rangeHours, rangeUntilHours);
  const { byAgent: latestMetrics } = useLatestSystemMetrics();
  // The trend is a FIXED recent window (last 30 days, ending now) — deliberately
  // decoupled from the table's range selector above it. Coupling it to the range
  // was the source of two bugs: on the default "Today" range it collapsed to a
  // single bar, and anchoring to a historic custom range's end could point the
  // window at a no-data period so the whole strip read as empty. A trend should
  // always show recent history regardless of which day the tables are filtered
  // to, so it's a constant window now.
  const TREND_DAYS = 30;
  const { rows: dailyRows } = useOrgProductivityDaily(TREND_DAYS, 0);

  // All per-agent aggregates come from a single RPC call; each table just maps over them.
  const { agents, systemData, timeData, activityCounts, weeklyProductivity } = useMemo(() => {
    const out: ReportAgent[] = [];
    const sysOut: Record<string, { cpu: number | null; memory: number | null; disk: number | null; uptime: string }> = {};
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
        cpu: m?.cpu_usage ?? null,
        memory: m?.ram_usage ?? null,
        disk: m?.disk_usage ?? null,
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

    // Weekday names only make sense for a week or less — beyond that "Mon"
    // appears four times over. Longer spans get the date.
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const buckets = dailyRows.map((r) => {
      const d = new Date(r.day_bucket + 'T00:00:00Z');
      return {
        key: r.day_bucket,
        day: dailyRows.length <= 7
          ? DAYS[d.getUTCDay()] ?? ''
          : String(d.getUTCDate()),
        full: d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }),
        productivity: r.productivity_pct,
        agents: r.active_agents,
      };
    });

    return { agents: out, systemData: sysOut, timeData: timeOut, activityCounts: actOut, weeklyProductivity: buckets };
  }, [dbAgents, perAgent, latestMetrics, dailyRows]);
  const [activeTab, setActiveTab] = useState<ReportTab>('productivity');
  const [deptFilter, setDeptFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => {
      const dept = a.department?.trim() ? a.department : 'Unassigned';
      const matchesDept = deptFilter === 'All' || dept === deptFilter;
      const matchesStatus = statusFilter === 'All' || a.status === statusFilter;
      const matchesSearch =
        search === '' ||
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.machine.toLowerCase().includes(search.toLowerCase());
      return matchesDept && matchesStatus && matchesSearch;
    });
  }, [agents, deptFilter, statusFilter, search]);

  // Row selection. A set of agent ids the user has ticked in the table.
  // The selection persists across tab switches (it's keyed on agent, not
  // tab) so ticking rows on Productivity and then exporting on Activity
  // exports the same agents. When non-empty it drives ALL exports —
  // CSV, Excel and PDF alike — not just the CSV button.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Only rows that are BOTH selected and currently visible under the
  // filters count. This keeps a stale tick on a now-hidden agent from
  // silently leaking into an export.
  const selectedFiltered = useMemo(
    () => filteredAgents.filter((a) => selectedIds.has(a.id)),
    [filteredAgents, selectedIds],
  );
  const allVisibleSelected = filteredAgents.length > 0 && selectedFiltered.length === filteredAgents.length;
  const someVisibleSelected = selectedFiltered.length > 0 && !allVisibleSelected;

  const toggleRow = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const toggleAllVisible = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (filteredAgents.every((a) => next.has(a.id))) {
        filteredAgents.forEach((a) => next.delete(a.id));
      } else {
        filteredAgents.forEach((a) => next.add(a.id));
      }
      return next;
    });
  const clearSelection = () => setSelectedIds(new Set());

  // Department filter options, derived from the agents actually present
  // rather than a hardcoded list — so it always reflects real data.
  // Agents with no department fall under "Unassigned".
  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) set.add(a.department?.trim() ? a.department : 'Unassigned');
    return ['All', ...Array.from(set).sort((x, y) => x.localeCompare(y))];
  }, [agents]);

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
          // The last three come from the newest hardware sample, not from the
          // selected range — say so, or a monthly export reads as if the CPU
          // figure were a monthly average.
          headers: ['Agent Name', 'Department', 'Machine', 'OS', 'Status', 'Productivity %', 'Active Hours', 'Idle Time', 'Total Session', 'Total Events', 'Alerts', 'CPU % (latest)', 'RAM % (latest)', 'Disk % used (latest)'],
          rows: data.map((a) => {
            const c = activityCounts[a.id] || { appSwitches: 0, browserEvents: 0, screenshots: 0, videos: 0, alerts: 0 };
            const t = timeData[a.id] || { session: '-', breaks: '-' };
            const s = systemData[a.id] ?? { cpu: null, memory: null, disk: null };
            const total = c.appSwitches + c.browserEvents + c.screenshots + c.videos + c.alerts;
            return [
              a.name,
              a.department,
              a.machine,
              a.os,
              a.status,
              String(a.productivity),
              a.activeHours,
              a.idleTime,
              t.session,
              String(total),
              String(c.alerts),
              s.cpu === null ? '' : String(s.cpu),
              s.memory === null ? '' : String(s.memory),
              s.disk === null ? '' : String(s.disk),
            ];
          }),
        };
      case 'activity':
        return {
          headers: ['Agent Name', 'Department', 'Machine', 'OS', 'Status', 'App Switches', 'Browser Events', 'Screenshots', 'Videos', 'Alerts', 'Total Events'],
          rows: data.map((a) => {
            const c = activityCounts[a.id] || { appSwitches: 0, browserEvents: 0, screenshots: 0, videos: 0, alerts: 0 };
            return [
              a.name,
              a.department,
              a.machine,
              a.os,
              a.status,
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
          headers: ['Agent Name', 'Department', 'Machine', 'OS', 'Status', 'Login Time', 'Logout Time', 'Total Session', 'Break Duration', 'Active Hours', 'Idle Time', 'Utilization %'],
          rows: data.map((a) => {
            const t = timeData[a.id] || { login: '-', logout: '-', session: '-', breaks: '-' };
            const sessionMins = parseInt(t.session) || 0;
            const breakMins = parseInt(t.breaks) || 0;
            const util = sessionMins > 0 ? Math.round(((sessionMins - breakMins) / sessionMins) * 100) : 0;
            return [
              a.name,
              a.department,
              a.machine,
              a.os,
              a.status,
              t.login,
              t.logout,
              t.session,
              t.breaks,
              a.activeHours,
              a.idleTime,
              String(util),
            ];
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

  // Render a real PDF via jspdf + autotable: a plain one-row-per-agent
  // table for the current tab, matching the CSV / Excel export.
  const buildPDF = async (): Promise<Blob> => {
    const [{ default: jsPDF }, autoTableModule] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const autoTable = (autoTableModule as { default: (doc: unknown, opts: unknown) => void }).default;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

    const dataForExport = selectedFiltered.length > 0 ? selectedFiltered : filteredAgents;
    const now = new Date().toLocaleString();
    const label = activeTab === 'productivity' ? 'Productivity' : activeTab === 'activity' ? 'Activity' : 'Time Tracking';

    doc.setFontSize(16);
    doc.setTextColor(20, 20, 20);
    doc.text(`Reports - ${label}`, 40, 40);
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    doc.text(`${dataForExport.length} agent${dataForExport.length === 1 ? '' : 's'}    Window: ${rangeLabel}    Generated: ${now}`, 40, 60);

    const { headers, rows } = buildTabRows(activeTab, dataForExport);
    autoTable(doc, {
      head: [headers],
      body: rows,
      startY: 80,
      theme: 'striped',
      headStyles: { fillColor: [16, 185, 129], textColor: 255, fontSize: 8 },
      bodyStyles: { fontSize: 8, textColor: 30 },
      margin: { left: 40, right: 40 },
      styles: { cellPadding: 4, overflow: 'linebreak' },
    });

    return doc.output('blob');
  };


  const handleExport = async (format: ExportFormat) => {
    setExporting(format);

    const dateStr = new Date().toISOString().split('T')[0];
    // Selection drives the export: the ticked rows, or all filtered rows
    // when nothing is ticked. Output is a plain one-row-per-agent sheet for
    // the current tab.
    const dataForExport = selectedFiltered.length > 0 ? selectedFiltered : filteredAgents;
    const selectedTag = selectedFiltered.length > 0 ? `_selected_${dataForExport.length}` : '';
    const filename = `Rudrans_${activeTab}${selectedTag}_report_${dateStr}`;

    try {
      if (format === 'pdf') {
        const blob = await buildPDF();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${filename}.pdf`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        // Simple flat table: header row + one row per agent, current tab.
        const csvBody = buildCSV(activeTab, dataForExport);
        if (format === 'csv') {
          // BOM so Excel/Sheets read it as UTF-8 (no mojibake on any
          // non-ASCII values that slip into the data).
          downloadFile('﻿' + csvBody, `${filename}.csv`, 'text/csv;charset=utf-8;');
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
        <Breadcrumb
          items={[
            { label: 'Dashboard', icon: 'ri-dashboard-line', to: '/dashboard' },
            { label: 'Reports' },
          ]}
        />

        {/* Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-poppins font-bold text-white mb-1">Reports</h1>
            <p className="text-sm text-gray-500">
              {filteredAgents.length} agents · {rangeLabel}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Export scope hint — reflects the table row selection. Tick
                rows to export just those; one row → full per-agent report. */}
            {selectedFiltered.length > 0 ? (
              <span className="flex items-center gap-1.5 mr-1 text-xs text-emerald-400">
                {selectedFiltered.length} selected
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={!!exporting}
                  title="Clear selection"
                  className="text-gray-500 hover:text-gray-300 disabled:opacity-50"
                >
                  <i className="ri-close-line" />
                </button>
              </span>
            ) : (
              <span className="text-xs text-gray-500 mr-1">
                All {filteredAgents.length} agent{filteredAgents.length === 1 ? '' : 's'}
              </span>
            )}
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
          {dateRange === 'custom' && (
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={customFrom}
                max={customTo || new Date().toISOString().split('T')[0]}
                onChange={(e) => setCustomFrom(e.target.value)}
                title="From date"
                className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-xs text-gray-300 focus:outline-none [color-scheme:dark]"
              />
              <span className="text-xs text-gray-500">to</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                max={new Date().toISOString().split('T')[0]}
                onChange={(e) => setCustomTo(e.target.value)}
                title="To date"
                className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-xs text-gray-300 focus:outline-none [color-scheme:dark]"
              />
            </div>
          )}
        </div>

        {/* ─── PRODUCTIVITY TABLE ─── */}
        {activeTab === 'productivity' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="w-10 px-4 py-3">
                      <SelectAllCheckbox
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        onChange={toggleAllVisible}
                        title="Select all visible"
                      />
                    </th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Agent</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Department</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Status</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Productivity</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Active Hours</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Idle Time</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map((agent) => (
                    <tr key={agent.id} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(agent.id)}
                          onChange={() => toggleRow(agent.id)}
                          title={`Select ${agent.name}`}
                          className="w-3.5 h-3.5 rounded border-dark-600 bg-dark-900 accent-emerald-500 cursor-pointer"
                        />
                      </td>
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
                    <th className="w-10 px-4 py-3">
                      <SelectAllCheckbox
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        onChange={toggleAllVisible}
                        title="Select all visible"
                      />
                    </th>
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
                          <input
                            type="checkbox"
                            checked={selectedIds.has(agent.id)}
                            onChange={() => toggleRow(agent.id)}
                            title={`Select ${agent.name}`}
                            className="w-3.5 h-3.5 rounded border-dark-600 bg-dark-900 accent-emerald-500 cursor-pointer"
                          />
                        </td>
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
                    <th className="w-10 px-4 py-3">
                      <SelectAllCheckbox
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        onChange={toggleAllVisible}
                        title="Select all visible"
                      />
                    </th>
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
                          <input
                            type="checkbox"
                            checked={selectedIds.has(agent.id)}
                            onChange={() => toggleRow(agent.id)}
                            title={`Select ${agent.name}`}
                            className="w-3.5 h-3.5 rounded border-dark-600 bg-dark-900 accent-emerald-500 cursor-pointer"
                          />
                        </td>
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
              <h3 className="text-sm font-semibold text-white">Productivity trend</h3>
              <span className="text-xs text-gray-500">
                {weeklyProductivity.length === 0 ? 'No data' : `Last ${weeklyProductivity.length} days`}
              </span>
            </div>
            {weeklyProductivity.length === 0 && (
              <p className="text-xs text-gray-500 py-8 text-center">
                No productivity recorded in the last 30 days.
              </p>
            )}
            <div className="flex items-end gap-1 md:gap-2 h-32">
              {weeklyProductivity.map((d) => (
                <div key={d.key} className="flex-1 flex flex-col items-center gap-1.5 min-w-0" title={`${d.full} · ${d.productivity}% · ${d.agents} agent${d.agents === 1 ? '' : 's'}`}>
                  {/* The per-bar percentage only fits while the bars are wide. */}
                  {weeklyProductivity.length <= 14 && (
                    <div className="text-xs text-gray-500 mb-1">{d.productivity}%</div>
                  )}
                  <div
                    className="w-full bg-dark-700 rounded-t-md relative overflow-hidden"
                    style={{ height: `${Math.max(2, (d.productivity / 100) * BAR_MAX_PX)}px` }}
                  >
                    <div className="absolute inset-0 bg-emerald-500/30 rounded-t-md" />
                  </div>
                  <span className="text-[10px] text-gray-400 font-medium truncate w-full text-center">{d.day}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}