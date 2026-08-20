import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAgents, type UiAgent } from '@/lib/dataHooks';
import { Bar } from '@/pages/dashboard/components/ui';
import { C } from '@/pages/dashboard/components/chartKit';
import PressureChart from './components/PressureChart';
import {
  formatAge,
  LIMITS,
  overage,
  useFleetMetrics,
  WINDOWS,
  type AgentMetrics,
  type MetricKey,
  type WindowId,
} from './useFleetMetrics';

/* Fleet hardware health.

   The numbers here used to come from a hook that only looked back 30 minutes,
   with `?? 0` behind it — so a fleet whose newest sample was an hour old read
   "Avg CPU 0%", "Avg Memory 0%", empty usage bars, "Last Seen: never", and
   "All agents are running healthy" while its last known readings included a
   machine at 96% CPU and 93% RAM. Every one of those was a fabrication.

   Now: last known reading per agent with its age, "—" where there is no
   reading, an explicit live/last-known label on every aggregate, and the trend
   chart the agent-detail card has always pointed here for. */

const TABS = ['Overview', 'Agents', 'Network'] as const;
type Tab = (typeof TABS)[number];
type ExportFormat = 'csv' | 'excel' | 'pdf';

const toneFor = (key: MetricKey, v: number | null): string => {
  if (v === null) return C.neutral;
  const l = LIMITS[key];
  return v >= l.high ? C.danger : v >= l.watch ? C.warning : C.success;
};

/** The rule, written out — so a coloured number is explainable. */
const RULE = `CPU ${LIMITS.cpu.watch}% · memory ${LIMITS.memory.watch}% · disk ${LIMITS.disk.watch}% · space ${LIMITS.space.watch}%`;

const OS_ICON = (os: string) => {
  if (os.includes('Windows')) return 'ri-windows-fill';
  if (os.includes('macOS') || os.includes('Darwin')) return 'ri-apple-fill';
  if (os.includes('Unknown')) return 'ri-question-line';
  return 'ri-ubuntu-fill';
};

/** How far any one metric is past its own watch level. 0 = nothing to see. */
const worstOverage = (m: AgentMetrics): number =>
  Math.max(
    overage('cpu', m.cpu),
    overage('memory', m.memory),
    overage('disk', m.disk),
    overage('space', m.space),
  );

function Reading({ metric, value, width = 52 }: { metric: MetricKey; value: number | null; width?: number }) {
  if (value === null) return <span className="text-[11px] t3">—</span>;
  const tone = toneFor(metric, value);
  return (
    <span
      className="flex items-center gap-2 justify-end"
      title={
        (metric === 'disk'
          ? 'disk I/O activity — the same measure as Task Manager\'s "Disk" column'
          : metric === 'space' ? 'share of the drive that is full'
          : metric === 'memory' ? 'memory in use' : 'CPU activity')
        + ` · watch at ${LIMITS[metric].watch}%, high at ${LIMITS[metric].high}%`
      }
    >
      <span className="flex-1 min-w-[36px] hidden lg:block" style={{ maxWidth: width }}>
        <Bar pct={value} height={4} color={tone} animate={false} />
      </span>
      <span className="text-[11.5px] tnum text-right w-[34px]" style={{ color: tone }}>
        {value}%
      </span>
    </span>
  );
}

export default function SystemHealthPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('Overview');
  const [windowId, setWindowId] = useState<WindowId>('24h');
  const [search, setSearch] = useState('');
  const { agents } = useAgents();
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents]);
  const { byAgent, series, loading, truncated, refresh, hours } = useFleetMetrics(windowId, agentIds);

  const windowLabel = WINDOWS.find((w) => w.id === windowId)?.label ?? '';

  const filtered = agents.filter(
    (a) =>
      search === ''
      || a.name.toLowerCase().includes(search.toLowerCase())
      || a.machine.toLowerCase().includes(search.toLowerCase()),
  );

  // Live = a sample inside the reporting interval. Everything else is a last
  // known reading, and the UI has to say which it is.
  const live = agents.filter((a) => byAgent[a.id]?.fresh);
  const withAny = agents.filter((a) => byAgent[a.id]?.recordedAt);
  const noData = agents.filter((a) => !byAgent[a.id]?.recordedAt);

  const avg = (pick: (m: AgentMetrics) => number | null): number | null => {
    const vals = withAny.map((a) => pick(byAgent[a.id])).filter((v): v is number => v !== null);
    return vals.length ? Math.round(vals.reduce((x, y) => x + y, 0) / vals.length) : null;
  };
  const avgCpu = avg((m) => m.cpu);
  const avgMem = avg((m) => m.memory);
  const avgDisk = avg((m) => m.disk);
  const avgSpace = avg((m) => m.space);

  // Ranked by how far past its own watch level the worst metric is, so the list
  // is a queue rather than an unordered set.
  const needsAttention = withAny
    .map((a) => ({ agent: a, m: byAgent[a.id], over: worstOverage(byAgent[a.id]) }))
    .filter((r) => r.over > 0)
    .sort((a, b) => b.over - a.over);

  // How current the aggregates are: the freshest reading behind them.
  const freshest = withAny.reduce<number | null>((min, a) => {
    const age = byAgent[a.id].ageMs;
    if (age === null) return min;
    return min === null || age < min ? age : min;
  }, null);
  const basis = live.length > 0
    ? `live · ${live.length} of ${agents.length} reporting`
    : withAny.length > 0
      ? `last known · newest ${formatAge(freshest)}`
      : 'no readings';

  const cells = [
    {
      label: 'Reporting now',
      value: `${live.length}/${agents.length}`,
      sub: live.length === 0 ? 'no live hardware data' : 'pushed within 3 min',
      icon: 'ri-wifi-line',
    },
    {
      label: 'Needs attention',
      value: String(needsAttention.length),
      sub: needsAttention.length === 0 ? 'all within limits' : RULE,
      icon: 'ri-error-warning-line',
      tone: needsAttention.length > 0 ? 't-warning' : undefined,
    },
    {
      label: 'Avg CPU',
      value: avgCpu === null ? '—' : `${avgCpu}%`,
      sub: basis,
      icon: 'ri-cpu-line',
    },
    {
      label: 'Avg disk',
      value: avgDisk === null ? '—' : `${avgDisk}%`,
      sub: avgDisk === null ? 'not reported by this agent build' : 'I/O activity, like Task Manager',
      icon: 'ri-hard-drive-2-line',
    },
    {
      label: 'Avg memory',
      value: avgMem === null ? '—' : `${avgMem}%`,
      sub: avgSpace === null ? 'space —' : `space ${avgSpace}% full`,
      icon: 'ri-database-2-line',
    },
  ];

  const fleetRows = [
    { label: 'Reporting live', value: live.length, icon: 'ri-wifi-line', tone: C.success },
    { label: 'Stale reading only', value: withAny.length - live.length, icon: 'ri-history-line', tone: C.warning },
    { label: `No reading in ${windowLabel}`, value: noData.length, icon: 'ri-wifi-off-line', tone: C.neutral },
    { label: 'Enrolled agents', value: agents.length, icon: 'ri-team-line', tone: C.accent },
  ];

  const agentRow = (a: UiAgent) => {
    const m = byAgent[a.id];
    return { a, m };
  };

  // network_speed is a raw agent string: sometimes "↓1.2 ↑0.3 Mbps" (two
  // numbers), sometimes just "42 Mbps". Only split it into Down/Up columns when
  // some agent actually reported both.
  const hasUpDown = agents.some((a) => byAgent[a.id]?.up !== null);

  // ─── Export ────────────────────────────────────────────────────────────
  //
  // One dropdown, three formats (CSV / Excel / PDF), scoped to whichever
  // tab the admin is currently looking at. Excel is a BOM-prefixed CSV so
  // it opens directly in Excel without garbling accented characters — same
  // pattern as /reports so we don't ship a full xlsx encoder for what fits
  // in a handful of columns.
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const fmt = (n: number | null): string => (n === null ? '—' : String(n));
  const fmtPct = (n: number | null): string => (n === null ? '—' : `${n}%`);
  const readingCell = (m: AgentMetrics | undefined): string => {
    if (!m || m.recordedAt === null) return 'no data';
    return m.fresh ? 'live' : formatAge(m.ageMs);
  };

  // Headers + rows for the tab being exported. In one place so PDF, Excel
  // and CSV share the exact same shape and stay in sync when a column is
  // added or renamed.
  const buildTabRows = (t: Tab): { headers: string[]; rows: string[][] } => {
    switch (t) {
      case 'Overview':
        return {
          headers: ['Metric', 'Value', 'Notes'],
          rows: [
            ['Reporting now',   `${live.length}/${agents.length}`,           live.length === 0 ? 'no live hardware data' : 'pushed within 3 min'],
            ['Needs attention', String(needsAttention.length),               needsAttention.length === 0 ? 'all within limits' : RULE],
            ['Avg CPU',         fmtPct(avgCpu),                              basis],
            ['Avg disk (I/O)',  fmtPct(avgDisk),                             avgDisk === null ? 'not reported by this agent build' : 'I/O activity, like Task Manager'],
            ['Avg memory',      fmtPct(avgMem),                              avgSpace === null ? 'space —' : `space ${avgSpace}% full`],
            ['Reporting live',  String(live.length),                         windowLabel],
            ['Stale reading',   String(withAny.length - live.length),        windowLabel],
            ['No reading',      String(noData.length),                       `no data in ${windowLabel}`],
            ['Enrolled agents', String(agents.length),                       ''],
          ],
        };
      case 'Agents':
        return {
          headers: ['Agent', 'Machine', 'OS', 'CPU %', 'Memory %', 'Disk %', 'Disk Space %', 'Battery %', 'Reading'],
          rows: filtered.map((a) => {
            const m = byAgent[a.id];
            return [
              a.name,
              a.machine,
              a.os,
              fmtPct(m?.cpu ?? null),
              fmtPct(m?.memory ?? null),
              fmtPct(m?.disk ?? null),
              fmtPct(m?.space ?? null),
              fmtPct(m?.battery ?? null),
              readingCell(m),
            ];
          }),
        };
      case 'Network': {
        const cols = ['Agent', 'Machine', 'IP Address', 'Link Speed'];
        if (hasUpDown) cols.push('Down Mbps', 'Up Mbps');
        cols.push('Reading');
        return {
          headers: cols,
          rows: filtered.map((a) => {
            const m = byAgent[a.id];
            const row = [a.name, a.machine, a.ipAddress, m?.network ?? '—'];
            if (hasUpDown) {
              row.push(m?.down === null || m?.down === undefined ? '—' : m.down.toFixed(1));
              row.push(m?.up === null || m?.up === undefined ? '—' : m.up.toFixed(1));
            }
            row.push(readingCell(m));
            return row;
          }),
        };
      }
    }
  };

  const buildCSV = (t: Tab): string => {
    const { headers, rows } = buildTabRows(t);
    const escape = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
    return [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');
  };

  const downloadFile = (content: BlobPart, filename: string, mime: string) => {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Real PDF via jspdf + autotable — dynamic-imported so the ~150 KB
  // bundle doesn't inflate the page load. Only paid when the admin
  // actually clicks "PDF".
  const buildPDF = async (t: Tab): Promise<Blob> => {
    const [{ default: jsPDF }, autoTableModule] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const autoTable = (autoTableModule as { default: (doc: unknown, opts: unknown) => void }).default;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

    doc.setFontSize(16);
    doc.setTextColor(20, 20, 20);
    doc.text(`System Health — ${t}`, 40, 40);

    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    doc.text(
      [
        `${agents.length} agent${agents.length === 1 ? '' : 's'}`,
        `${live.length} live`,
        `${needsAttention.length} needing attention`,
        `Window: ${windowLabel}`,
        `Generated: ${new Date().toLocaleString()}`,
      ].join('   ·   '),
      40, 60,
    );

    const { headers, rows } = buildTabRows(t);
    autoTable(doc, {
      head: [headers],
      body: rows,
      startY: 80,
      theme: 'striped',
      headStyles: { fillColor: [16, 185, 129], textColor: 255, fontSize: 9 },
      bodyStyles: { fontSize: 8, textColor: 30 },
      margin: { left: 40, right: 40 },
      styles: { cellPadding: 4, overflow: 'linebreak' },
    });
    return doc.output('blob');
  };

  const handleExport = async (format: ExportFormat) => {
    setExporting(format);
    setMenuOpen(false);
    const dateStr = new Date().toISOString().split('T')[0];
    const base = `WellnessExtract_SystemHealth_${tab}_${dateStr}`;
    try {
      if (format === 'pdf') {
        const blob = await buildPDF(tab);
        downloadFile(blob, `${base}.pdf`, 'application/pdf');
      } else if (format === 'excel') {
        // BOM prefix so Excel opens UTF-8 without garbling headers.
        const csv = '﻿' + buildCSV(tab);
        downloadFile(csv, `${base}.csv`, 'text/csv;charset=utf-8');
      } else {
        downloadFile(buildCSV(tab), `${base}.csv`, 'text/csv;charset=utf-8');
      }
    } finally {
      setExporting(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="dash min-w-0 max-w-full">
        <div className="flex items-center gap-1.5 text-[10.5px] t3 mb-3">
          <Link to="/dashboard" className="hover:underline flex items-center gap-1">
            <i className="ri-dashboard-line text-[12px]" />
            Dashboard
          </Link>
          <i className="ri-arrow-right-s-line" />
          <span className="t1 font-medium">System health</span>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <h1 className="num" style={{ fontSize: 17 }}>System health</h1>
            <span className={`inline-flex items-center gap-1.5 text-[11px] ${live.length > 0 ? 't-success' : 't3'}`}>
              <span className={`live-dot ${live.length > 0 ? '' : 'is-off'}`} />
              {basis}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="seg">
              {WINDOWS.map((w) => (
                <button
                  key={w.id}
                  onClick={() => setWindowId(w.id)}
                  className={`seg-btn ${windowId === w.id ? 'is-on' : ''}`}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <button onClick={() => void refresh()} className="chip chip-quiet text-[10.5px]">
              <i className={`ri-refresh-line ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {/* Export dropdown — one button, three formats (CSV / Excel /
                PDF). Downloads whichever tab is active so the report matches
                what the admin is looking at. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                disabled={exporting !== null}
                className="chip chip-quiet text-[10.5px] disabled:opacity-50"
              >
                <i className="ri-download-2-line" />
                <span>{exporting ? `Exporting ${exporting.toUpperCase()}…` : `Export ${tab}`}</span>
                <i className={`ri-arrow-down-s-line transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
              </button>
              {menuOpen && (
                <>
                  {/* Click-outside overlay to close the menu. */}
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-20 min-w-[180px] panel p-1">
                    {(['csv', 'excel', 'pdf'] as ExportFormat[]).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => handleExport(f)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] t2 hover:opacity-80"
                        style={{ borderRadius: 6 }}
                      >
                        <i className={`text-[13px] ${
                          f === 'pdf' ? 'ri-file-pdf-2-line t-danger'
                            : f === 'excel' ? 'ri-file-excel-2-line t-success'
                            : 'ri-file-text-line t-info'
                        }`} />
                        <span>Download as {f === 'pdf' ? 'PDF' : f === 'excel' ? 'Excel' : 'CSV'}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {truncated && (
          <div className="banner is-notice mb-2.5">
            <span className="flex items-start gap-2">
              <i className="ri-information-line text-[13px] t-warning mt-px" />
              <span className="text-[11.5px] t-warning">
                Showing the most recent samples only — this window holds more than the page fetches.
                Narrow the range for a complete picture.
              </span>
            </span>
          </div>
        )}

        <div className="panel overflow-hidden mb-3">
          <div className="pent-grid">
            {cells.map((c) => (
              <div key={c.label} className="px-3.5 py-3 min-w-0">
                <span className="flex items-center gap-1.5">
                  <i className={`${c.icon} text-[12px] t3`} />
                  <span className="label">{c.label}</span>
                </span>
                <p className={`num num-lg mt-1.5 ${c.tone ?? ''}`}>{c.value}</p>
                <p className="text-[10px] t3 mt-1 truncate" title={c.sub}>{c.sub}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="seg overflow-x-auto max-w-full mb-3">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`seg-btn ${tab === t ? 'is-on' : ''}`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'Overview' && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5">
              <div className="lg:col-span-8 min-w-0 flex">
                <PressureChart series={series} windowLabel={windowLabel} spanHours={hours} index={1} />
              </div>

              <div className="lg:col-span-4 min-w-0 flex">
                <div className="panel rise flex flex-col flex-1" style={{ ['--i' as string]: 2 }}>
                  <header className="panel-head flex-shrink-0">
                    <h3 className="panel-title">Reporting</h3>
                    <span className="label">{windowLabel}</span>
                  </header>
                  <div className="panel-body flex-1 flex flex-col gap-1.5">
                    {fleetRows.map((r) => (
                      <div key={r.label} className="ctl-row">
                        <span className="flex items-center gap-2.5 min-w-0">
                          <i className={`${r.icon} text-[13px]`} style={{ color: r.tone }} />
                          <span className="text-[11.5px] t2 truncate">{r.label}</span>
                        </span>
                        <span className="num num-md tnum" style={{ color: r.value > 0 ? r.tone : 'var(--d-t3)' }}>
                          {r.value}
                        </span>
                      </div>
                    ))}
                    <p className="text-[10px] t3 mt-auto pt-2">
                      A reading counts as live when it arrived within 3 minutes — agents push every
                      minute while running.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="panel">
              <header className="panel-head">
                <h3 className="panel-title">Needs attention</h3>
                <span className="label" title="Levels a reading is judged against">{RULE}</span>
              </header>
              {needsAttention.length === 0 ? (
                <div className="panel-body py-6 text-center">
                  {withAny.length === 0 ? (
                    <>
                      <i className="ri-wifi-off-line text-[22px] t3 block mb-2" />
                      <p className="text-[12.5px] t2">No hardware readings to judge</p>
                      <p className="text-[11px] t3 mt-1">
                        {agents.length === 0
                          ? 'No agents are enrolled yet.'
                          : `None of the ${agents.length} enrolled agents reported in the last ${windowLabel}.`}
                      </p>
                    </>
                  ) : (
                    <>
                      <i className="ri-shield-check-line text-[22px] t-success block mb-2" />
                      <p className="text-[12.5px] t2">
                        All {withAny.length} agent{withAny.length === 1 ? '' : 's'} within limits
                      </p>
                      <p className="text-[11px] t3 mt-1">{basis}</p>
                    </>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="d-table" style={{ minWidth: 720 }}>
                    <thead>
                      <tr className="hair-b">
                        <th>Agent</th>
                        <th className="text-right" style={{ width: 120 }}>CPU</th>
                        <th className="text-right" style={{ width: 120 }}>Memory</th>
                        <th className="text-right" style={{ width: 110 }} title="Disk I/O activity, as in Task Manager">Disk</th>
                        <th className="text-right" style={{ width: 110 }} title="Share of the drive that is full">Disk space</th>
                        <th className="text-right" style={{ width: 86 }}>Reading</th>
                      </tr>
                    </thead>
                    <tbody>
                      {needsAttention.map(({ agent: a, m }) => (
                        <tr key={a.id} onClick={() => navigate(`/agents/${a.id}`)}>
                          <td>
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="avatar flex-shrink-0">{a.name.charAt(0).toUpperCase()}</span>
                              <span className="min-w-0">
                                <span className="block text-[12px] t1 truncate">{a.name}</span>
                                <span className="block text-[10px] t3 truncate">{a.machine}</span>
                              </span>
                            </span>
                          </td>
                          <td><Reading metric="cpu" value={m.cpu} /></td>
                          <td><Reading metric="memory" value={m.memory} /></td>
                          <td><Reading metric="disk" value={m.disk} /></td>
                          <td><Reading metric="space" value={m.space} /></td>
                          <td className="text-right">
                            <span className={`text-[10.5px] ${m.fresh ? 't-success' : 't-warning'}`}>
                              {m.fresh ? 'live' : formatAge(m.ageMs)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {(tab === 'Agents' || tab === 'Network') && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[10.5px] t3">
                {tab === 'Agents'
                  ? 'Last known reading per agent. Rows open the agent.'
                  : 'Link speed as reported with the last hardware sample.'}
              </span>
              <label className="field" style={{ minWidth: 210 }}>
                <i className="ri-search-line text-[12px] t3" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Agent or machine…"
                  className="w-full text-[11.5px]"
                />
                {search && (
                  <button onClick={() => setSearch('')} className="t3 hover:opacity-70" aria-label="Clear search">
                    <i className="ri-close-line text-[12px]" />
                  </button>
                )}
              </label>
            </div>

            <div className="panel overflow-hidden">
              {filtered.length === 0 ? (
                <div className="p-8 text-center">
                  <i className="ri-search-2-line text-[22px] t3 block mb-2" />
                  <p className="text-[12.5px] t2">
                    {agents.length === 0 ? 'No agents enrolled' : 'No agents match that search'}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="d-table" style={{ minWidth: tab === 'Agents' ? 940 : 660 }}>
                    <thead>
                      <tr className="hair-b">
                        <th>Agent</th>
                        {tab === 'Agents' ? (
                          <>
                            <th style={{ width: 118 }}>OS</th>
                            <th className="text-right" style={{ width: 118 }}>CPU</th>
                            <th className="text-right" style={{ width: 118 }}>Memory</th>
                            <th className="text-right" style={{ width: 112 }} title="Disk I/O activity, as in Task Manager">Disk</th>
                            <th className="text-right" style={{ width: 112 }} title="Share of the drive that is full">Disk space</th>
                            <th className="text-right" style={{ width: 70 }}>Battery</th>
                          </>
                        ) : (
                          <>
                            <th style={{ width: 130 }}>IP</th>
                            <th className="text-right" style={{ width: 130 }}>Link speed</th>
                            {hasUpDown && <th className="text-right" style={{ width: 90 }}>Down</th>}
                            {hasUpDown && <th className="text-right" style={{ width: 90 }}>Up</th>}
                          </>
                        )}
                        <th className="text-right" style={{ width: 96 }}>Reading</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(agentRow).map(({ a, m }) => (
                        <tr key={a.id} onClick={() => navigate(`/agents/${a.id}`)}>
                          <td>
                            <span className="flex items-center gap-2 min-w-0">
                              <span className="avatar flex-shrink-0">{a.name.charAt(0).toUpperCase()}</span>
                              <span className="min-w-0">
                                <span className="block text-[12px] t1 truncate">{a.name}</span>
                                <span className="block text-[10px] t3 truncate">{a.machine}</span>
                              </span>
                            </span>
                          </td>

                          {tab === 'Agents' ? (
                            <>
                              <td>
                                <span className="flex items-center gap-1.5 text-[11px] t3 min-w-0">
                                  <i className={`${OS_ICON(a.os)} text-[12px]`} />
                                  <span className="truncate">{a.os}</span>
                                </span>
                              </td>
                              <td><Reading metric="cpu" value={m.cpu} /></td>
                              <td><Reading metric="memory" value={m.memory} /></td>
                              <td><Reading metric="disk" value={m.disk} /></td>
                              <td><Reading metric="space" value={m.space} /></td>
                              <td className="text-right text-[11px] t3 tnum">
                                {m.battery === null ? '—' : `${m.battery}%`}
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="text-[11.5px] t2 tnum">{a.ipAddress}</td>
                              <td className="text-right text-[11px] t2 truncate">{m.network ?? '—'}</td>
                              {hasUpDown && (
                                <td className="text-right text-[11px] t3 tnum">
                                  {m.down === null ? '—' : `${m.down.toFixed(1)} Mbps`}
                                </td>
                              )}
                              {hasUpDown && (
                                <td className="text-right text-[11px] t3 tnum">
                                  {m.up === null ? '—' : `${m.up.toFixed(1)} Mbps`}
                                </td>
                              )}
                            </>
                          )}

                          <td className="text-right whitespace-nowrap">
                            {m.recordedAt === null ? (
                              <span className="text-[10.5px] t3">no data</span>
                            ) : (
                              <span className={`text-[10.5px] ${m.fresh ? 't-success' : 't3'}`}>
                                {m.fresh ? 'live' : formatAge(m.ageMs)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
