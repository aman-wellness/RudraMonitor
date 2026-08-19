import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAlerts } from '@/lib/dataHooks';
import { formatRelative, kindColor, prettyKind } from '@/lib/labels';
import { notify, promptDialog } from '@/lib/notify';

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

const WINDOW_HOURS = 24 * 7;

type Filter = 'open' | 'resolved' | 'all';

export default function AlertsPage() {
  const navigate = useNavigate();
  const { rows: allAlerts, loading, resolveAlert, refresh } = useAlerts({ sinceHours: WINDOW_HOURS });
  const [kind, setKind] = useState<string>('all');
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);

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
      label: 'Employees',
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
            <span className="text-[11px] t3">last 7 days</span>
          </div>
          <button onClick={() => void refresh()} className="chip chip-quiet text-[10.5px]">
            <i className={`ri-refresh-line ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
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
                placeholder="Message, employee, kind…"
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
                    <th style={{ width: 132 }}>Employee</th>
                    <th className="text-right" style={{ width: 74 }}>Raised</th>
                    <th className="text-right" style={{ width: 148 }} />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => {
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
        </div>
      </div>
    </DashboardLayout>
  );
}
