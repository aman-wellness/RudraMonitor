import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAlerts, useAgents } from '@/lib/dataHooks';
import { rangeBounds, type DateRange } from '@/lib/useAgentDetail';
import DateFilter from '@/pages/agent-detail/components/DateFilter';
import { formatRelative, kindColor, prettyKind } from '@/lib/labels';
import { notify, promptDialog } from '@/lib/notify';
import Pagination, { usePagination } from '@/pages/monitoring/components/Pagination';

/* Alert triage.

   What was wrong here, beyond the paint:

   • Two of the four summary tiles counted `alert_type === 'error'` and
     `=== 'warning'`. The column holds the KIND of alert the agent raised —
     high_cpu, idle_extended, offline, unauthorized_usb — so Critical and
     Warnings read 0 forever, on every org, no matter what happened. The icon
     and badge colour maps keyed off the same non-existent values, which is why
     every alert on the page was the same blue.
   • The only filter was "Resolved Only". There was no way to see just the
     alerts that still need action — the one view triage actually needs.
   • Each alert was a 116px card holding two short lines, with its actions
     hidden behind an expand. Twelve alerts ran to 1778px.
   • Resolving wrote the fixed string "Marked resolved by admin", so the
     resolution field — which the row already displays — never carried
     information. It now asks what was done. */


type Filter = 'open' | 'resolved' | 'all';

export default function AlertsPage() {
  const navigate = useNavigate();
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [range, setRange] = useState<DateRange>('7d');

  // Decoded with the same helper the agent-detail page uses, so "7 days" cannot
  // come to mean two different things in two places.
  const { since, until } = useMemo(() => rangeBounds(range), [range]);

  const { rows: allAlerts, loading, resolveAlert, resolveAlerts, refresh } = useAlerts({
    since, until,
    agentId: agentFilter === 'all' ? null : agentFilter,
    // Raised from the 200 default: the window is now the admin's choice, and
    // "30 days" on a busy fleet exceeds 200 easily. Pagination handles the
    // display, but a row that was never fetched cannot be paged to.
    limit: 2000,
  });
  const [kind, setKind] = useState<string>('all');
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Kinds are derived from the alert_type values actually present, so the filter
  // always reflects real agent alerts instead of a hardcoded Error/Warning/Info
  // list that never matched the data.
  const kinds = useMemo(
    () => Array.from(new Set(allAlerts.map((a) => a.alert_type).filter(Boolean))).sort(),
    [allAlerts],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allAlerts.filter((a) => {
      if (kind !== 'all' && a.alert_type !== kind) return false;
      if (filter === 'open' && a.ai_resolved) return false;
      if (filter === 'resolved' && !a.ai_resolved) return false;
      if (!q) return true;
      return (
        a.message.toLowerCase().includes(q)
        || (a.agent_name ?? '').toLowerCase().includes(q)
        || prettyKind(a.alert_type).toLowerCase().includes(q)
        || (a.resolution ?? '').toLowerCase().includes(q)
      );
    });
  }, [allAlerts, kind, filter, search]);

  // Alerts accumulate indefinitely, so this is the list most likely to reach
  // thousands of rows on a busy fleet.
  const { visible, page, pageCount, setPage, from, to, total } = usePagination(filtered);

  const open = allAlerts.filter((a) => !a.ai_resolved);
  const cells = [
    {
      label: 'Needs action',
      value: open.length,
      sub: open.length === 0 ? 'all clear' : 'unresolved alerts',
      icon: 'ri-error-warning-line',
      tone: open.length > 0 ? 't-warning' : undefined,
    },
    {
      label: 'Resolved',
      value: allAlerts.length - open.length,
      sub: 'closed out',
      icon: 'ri-check-double-line',
    },
    {
      label: 'Agents',
      value: new Set(open.map((a) => a.agent_id)).size,
      sub: 'with something open',
      icon: 'ri-team-line',
    },
    {
      label: 'Kinds',
      value: new Set(open.map((a) => a.alert_type)).size,
      sub: 'distinct open kinds',
      icon: 'ri-price-tag-3-line',
    },
  ];

  // "All" means everything the CURRENT filters match and that is still open —
  // not every alert in the org. Someone who has filtered to one kind, or
  // searched for one machine, is asking to clear that, and silently resolving
  // beyond what they can see would be the wrong kind of surprise. Scoped to
  // `filtered` rather than the visible page for the same reason: the button says
  // "all", and paging is a view concern.
  const openInView = useMemo(() => filtered.filter((a) => !a.ai_resolved), [filtered]);

  const onResolveAll = async () => {
    const note = await promptDialog({
      title: `Resolve ${openInView.length} alert${openInView.length === 1 ? '' : 's'}?`,
      body:
        openInView.length === filtered.length
          ? 'Every alert in this view will be marked resolved with the same note.'
          : `${openInView.length} of the ${filtered.length} alerts in this view are still open. `
            + 'They will all be marked resolved with the same note.',
      placeholder: 'What was done?',
      defaultValue: 'Reviewed in bulk and closed',
      confirmLabel: `Resolve ${openInView.length}`,
    });
    if (note === null) return;
    setBulkBusy(true);
    try {
      const n = await resolveAlerts(openInView.map((a) => a.id), note.trim());
      notify.success(`${n} alert${n === 1 ? '' : 's'} resolved`);
    } catch (e) {
      notify.fail('Could not resolve the alerts', e);
    } finally {
      setBulkBusy(false);
    }
  };

  const onResolve = async (alertId: string, message: string) => {
    // The resolution text is displayed on the row, so ask what was actually
    // done instead of stamping every alert with the same sentence.
    const note = await promptDialog({
      title: 'Resolve this alert',
      body: message,
      placeholder: 'What was done?',
      defaultValue: 'Reviewed and closed',
      confirmLabel: 'Mark resolved',
    });
    if (note === null) return;
    setResolving(alertId);
    try {
      await resolveAlert(alertId, note.trim());
      notify.success('Alert resolved');
    } catch (e) {
      notify.fail('Could not resolve the alert', e);
    } finally {
      setResolving(null);
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
          <span className="t1 font-medium">Alerts</span>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <h1 className="num" style={{ fontSize: 17 }}>Alerts</h1>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Only offered when the current view actually contains something to
                resolve, so it never appears as a button that would do nothing. */}
            {openInView.length > 0 && (
              <button
                onClick={() => void onResolveAll()}
                disabled={bulkBusy}
                className="chip chip-quiet text-[10.5px] disabled:opacity-50"
              >
                <i className={bulkBusy ? 'ri-loader-4-line animate-spin' : 'ri-check-double-line'} />
                {bulkBusy ? 'Resolving…' : `Resolve all (${openInView.length})`}
              </button>
            )}
            <button onClick={() => void refresh()} className="chip chip-quiet text-[10.5px]">
              <i className={`ri-refresh-line ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        <div className="panel overflow-hidden mb-3">
          <div className="quad-grid">
            {cells.map((c) => (
              <div key={c.label} className="px-3.5 py-3 min-w-0">
                <span className="flex items-center gap-1.5">
                  <i className={`${c.icon} text-[12px] t3`} />
                  <span className="label">{c.label}</span>
                </span>
                <p className={`num num-lg mt-1.5 ${c.tone ?? ''}`}>{c.value}</p>
                <p className="text-[10px] t3 mt-1 truncate">{c.sub}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 justify-between mb-2.5">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <div className="seg">
              {(['open', 'resolved', 'all'] as Filter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`seg-btn ${filter === f ? 'is-on' : ''}`}
                >
                  {f === 'open' ? 'Needs action' : f === 'resolved' ? 'Resolved' : 'All'}
                </button>
              ))}
            </div>

            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="filter-date"
              style={{ minWidth: 150 }}
            >
              <option value="all">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>

            <DateFilter
              onChange={(preset) => {
                // Custom ranges arrive as "custom:<fromISO>|<toISO>"; rangeBounds
                // decodes both forms.
                if (preset.startsWith('custom:')) { setRange(preset as DateRange); return; }
                const map: Record<string, DateRange> = {
                  'Today': 'today', 'Yesterday': 'yesterday',
                  '7 days': '7d', '30 days': '30d', 'All time': 'all',
                };
                setRange(map[preset] ?? '7d');
              }}
            />

            {kinds.length > 1 && (
              <div className="seg">
                <button
                  onClick={() => setKind('all')}
                  className={`seg-btn ${kind === 'all' ? 'is-on' : ''}`}
                >
                  All kinds
                </button>
                {kinds.map((k) => (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={`seg-btn ${kind === k ? 'is-on' : ''}`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: kindColor(k) }} />
                      {prettyKind(k)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {filtered.length > 0 && (
              <span className="text-[10.5px] t3 tnum">
                {filtered.length} of {allAlerts.length}
              </span>
            )}
            <label className="field" style={{ minWidth: 210 }}>
              <i className="ri-search-line text-[12px] t3" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Message, agent, kind…"
                className="w-full text-[11.5px]"
              />
              {search && (
                <button onClick={() => setSearch('')} className="t3 hover:opacity-70" aria-label="Clear search">
                  <i className="ri-close-line text-[12px]" />
                </button>
              )}
            </label>
          </div>
        </div>

        <div className="panel overflow-hidden">
          {loading && allAlerts.length === 0 ? (
            <p className="text-center text-[11px] t3 py-8">Loading…</p>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center">
              <i className="ri-shield-check-line text-[22px] t3 block mb-2" />
              <p className="text-[12.5px] t2">
                {allAlerts.length === 0
                  ? 'No alerts in the last 7 days'
                  : filter === 'open'
                    ? 'Nothing needs action'
                    : 'Nothing matches these filters'}
              </p>
              <p className="text-[11px] t3 mt-1">
                {allAlerts.length === 0
                  ? 'Agents raise alerts on resource thresholds, extended idle, USB use and going offline.'
                  : `${allAlerts.length} alert${allAlerts.length === 1 ? '' : 's'} in the window — widen the filters to see them.`}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="d-table" style={{ minWidth: 760 }}>
                <thead>
                  <tr className="hair-b">
                    <th style={{ width: 132 }}>Kind</th>
                    <th>Alert</th>
                    <th style={{ width: 132 }}>Agent</th>
                    <th className="text-right" style={{ width: 74 }}>Raised</th>
                    <th className="text-right" style={{ width: 148 }} />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((a) => {
                    const tone = kindColor(a.alert_type);
                    return (
                      <tr key={a.id}>
                        <td>
                          <span className="inline-flex items-center gap-1.5 min-w-0">
                            <span
                              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                              style={{ background: tone }}
                            />
                            <span
                              className="text-[9.5px] uppercase tracking-wide truncate"
                              style={{ color: tone }}
                            >
                              {prettyKind(a.alert_type)}
                            </span>
                          </span>
                        </td>

                        <td className="max-w-[420px]">
                          <span className="text-[12px] t1 truncate block" title={a.message}>
                            {a.message}
                          </span>
                          {/* The resolution note used to be behind an expand. It's
                              one line — show it. */}
                          {a.ai_resolved && a.resolution && (
                            <span className="text-[10px] t3 truncate block" title={a.resolution}>
                              <i className="ri-check-double-line mr-1 t-success" />
                              {a.resolution}
                            </span>
                          )}
                        </td>

                        <td className="max-w-[140px]">
                          <button
                            onClick={() => navigate(`/agents/${a.agent_id}`)}
                            className="text-[11.5px] t2 truncate hover:underline text-left w-full"
                            title="Open this agent"
                          >
                            {a.agent_name || 'Unknown'}
                          </button>
                        </td>

                        <td className="text-right text-[11px] t3 whitespace-nowrap tnum">
                          {formatRelative(a.created_at)}
                        </td>

                        <td className="text-right">
                          {a.ai_resolved ? (
                            <span className="text-[10.5px] t-success inline-flex items-center gap-1">
                              <i className="ri-check-double-line" />
                              resolved
                            </span>
                          ) : (
                            <button
                              onClick={() => void onResolve(a.id, a.message)}
                              disabled={resolving === a.id}
                              className="chip chip-quiet text-[10px] disabled:opacity-50"
                            >
                              <i className={resolving === a.id ? 'ri-loader-4-line animate-spin' : 'ri-check-line'} />
                              {resolving === a.id ? 'Resolving…' : 'Resolve'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Pagination
            page={page} pageCount={pageCount} from={from} to={to} total={total}
            onPage={setPage} unit="alerts"
          />
        </div>
      </div>
    </DashboardLayout>
  );
}
