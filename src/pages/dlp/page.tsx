import { useEffect, useMemo, useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import UpgradeRequired from '@/components/UpgradeRequired';
import { useFeatures } from '@/lib/useFeatures';
import EventsTable from './components/EventsTable';
import SettingsPanel from './components/SettingsPanel';
import { eventTypeIcon, eventTypeLabel, sevTone, SEVERITIES, useDlp } from './useDlp';
import type { DlpSeverity } from '@/lib/supabase';

type Tab = string; // an event_type, or 'settings'

export default function DlpPage() {
  const features = useFeatures();
  const { rows, settings, types, countsByType, summary, loading, error, refresh, orgId } = useDlp();
  const [tab, setTab] = useState<Tab>('');
  const [sevFilter, setSevFilter] = useState<DlpSeverity | 'all' | 'unauthorized'>('all');
  const [search, setSearch] = useState('');

  // Land on the first channel that exists. The old page hardcoded 'usb' as the
  // opening tab even for an org that only monitors email.
  useEffect(() => {
    if (tab === '' && types.length > 0) setTab(types[0]);
    if (tab === '' && types.length === 0 && !loading) setTab('settings');
  }, [tab, types, loading]);

  // Reset the severity filter + search when switching tabs (audit M9).
  // Otherwise a leftover "high" filter or search term carried into another
  // channel silently hides its events and shows the empty-state, making a full
  // channel look like it has no data.
  useEffect(() => { setSevFilter('all'); setSearch(''); }, [tab]);

  const visible = useMemo(() => {
    if (tab === 'settings') return [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (r.event_type !== tab) return false;
      if (sevFilter === 'unauthorized' && r.ai_authorized !== false) return false;
      if (sevFilter !== 'all' && sevFilter !== 'unauthorized' && r.ai_severity !== sevFilter) return false;
      if (!q) return true;
      return [
        r.agents?.agent_name, r.file_name, r.file_path, r.device_name, r.device_serial,
        r.recipient_email, r.sender_email, r.mail_provider, r.ai_reason, r.active_window,
      ].some((v) => (v ?? '').toLowerCase().includes(q));
    });
  }, [rows, tab, sevFilter, search]);

  // Gate the whole page behind the DLP feature flag. While useFeatures is
  // still resolving, fall through to the normal render — we don't want a
  // flash of "upgrade required" on every fresh page-load.
  if (!features.loading && !features.dlp_enabled) {
    return (
      <DashboardLayout>
        <UpgradeRequired
          feature="Data Loss Prevention"
          icon="ri-shield-keyhole-line"
          blurb="DLP monitors USB transfers, email attachments, and clipboard exfiltration with AI-powered classification. Available on Professional or as an add-on to Starter."
        />
      </DashboardLayout>
    );
  }

  const enabledFor = (t: string) =>
    t === 'usb_transfer' ? !!settings?.usb_enabled
    : t === 'email_attachment' ? !!settings?.email_enabled
    : t === 'clipboard_exfil' ? !!settings?.clipboard_enabled
    : true;

  const sevOrder: DlpSeverity[] = ['critical', 'high', 'medium', 'low'];
  const oldest = summary.oldest
    ? new Date(summary.oldest).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
    : null;

  return (
    <DashboardLayout>
      <div className="dash min-w-0 max-w-full">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <h1 className="num" style={{ fontSize: 17 }}>Data loss prevention</h1>
            {/* Says what the numbers below actually cover. The query is capped at
                500 rows, not a time window, so naming a period would be a guess. */}
            {oldest && (
              <span className="text-[11px] t3">
                {summary.total} event{summary.total === 1 ? '' : 's'} since {oldest}
              </span>
            )}
          </div>
          <button onClick={() => void refresh()} className="chip chip-quiet text-[10.5px]">
            <i className={`ri-refresh-line ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="banner mb-2.5">
            <span className="flex items-start gap-2 min-w-0">
              <i className="ri-error-warning-line text-[13px] t-danger mt-px" />
              <span className="text-[11.5px] t-danger">{error}</span>
            </span>
          </div>
        )}

        {/* Risk summary — the page opened straight onto a raw event list, so
            nothing told an owner whether anything needed attention. */}
        {summary.total > 0 && (
          <div className="panel overflow-hidden mb-3">
            <div className="quad-grid">
              <div className="px-3.5 py-3 min-w-0">
                <span className="flex items-center gap-1.5">
                  <i className="ri-shield-keyhole-line text-[12px] t3" />
                  <span className="label">Events</span>
                </span>
                <p className="num num-lg mt-1.5">{summary.total}</p>
                <p className="text-[10px] t3 mt-1 truncate">
                  across {summary.people || 0} agent{summary.people === 1 ? '' : 's'}
                </p>
              </div>

              <div className="px-3.5 py-3 min-w-0">
                <span className="flex items-center gap-1.5">
                  <i className="ri-close-circle-line text-[12px] t3" />
                  <span className="label">Unauthorized</span>
                </span>
                <p className={`num num-lg mt-1.5 ${summary.unauthorized > 0 ? 't-danger' : ''}`}>
                  {summary.unauthorized}
                </p>
                <p className="text-[10px] t3 mt-1 truncate">
                  {summary.unauthorized === 0 ? 'nothing flagged' : 'flagged by the classifier'}
                </p>
              </div>

              <div className="px-3.5 py-3 min-w-0">
                <span className="flex items-center gap-1.5">
                  <i className="ri-bar-chart-horizontal-line text-[12px] t3" />
                  <span className="label">Severity mix</span>
                </span>
                <div className="flex items-baseline gap-2.5 mt-1.5 flex-wrap">
                  {sevOrder.map((s) =>
                    summary.bySeverity[s] > 0 ? (
                      <span key={s} className="inline-flex items-baseline gap-1">
                        <span className="num num-md" style={{ color: sevTone(s) }}>
                          {summary.bySeverity[s]}
                        </span>
                        <span className="text-[10px]" style={{ color: sevTone(s) }}>{s}</span>
                      </span>
                    ) : null,
                  )}
                  {summary.unclassified > 0 && (
                    <span className="inline-flex items-baseline gap-1">
                      <span className="num num-md t3">{summary.unclassified}</span>
                      <span className="text-[10px] t3">unclassified</span>
                    </span>
                  )}
                </div>
                <span className="stack block mt-2" style={{ height: 4 }}>
                  {sevOrder.map((s) =>
                    summary.bySeverity[s] > 0 ? (
                      <i
                        key={s}
                        style={{
                          flexBasis: `${(summary.bySeverity[s] / summary.total) * 100}%`,
                          background: sevTone(s),
                        }}
                      />
                    ) : null,
                  )}
                </span>
              </div>

              <div className="px-3.5 py-3 min-w-0">
                <span className="flex items-center gap-1.5">
                  <i className="ri-mail-check-line text-[12px] t3" />
                  <span className="label">Alerts</span>
                </span>
                <p className="num num-lg mt-1.5">{summary.alerted}</p>
                <p className="text-[10px] t3 mt-1 truncate">
                  {summary.queued > 0 ? `${summary.queued} still queued` : 'emails sent'}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="seg overflow-x-auto max-w-full mb-3">
          {types.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`seg-btn ${tab === t ? 'is-on' : ''}`}
            >
              <span className="inline-flex items-center gap-1.5">
                <i className={`${eventTypeIcon(t)} text-[12px]`} />
                {eventTypeLabel(t)}
                <span className="t3">{countsByType[t] ?? 0}</span>
              </span>
            </button>
          ))}
          <button
            onClick={() => setTab('settings')}
            className={`seg-btn ${tab === 'settings' ? 'is-on' : ''}`}
          >
            <span className="inline-flex items-center gap-1.5">
              <i className="ri-settings-3-line text-[12px]" />
              Settings
            </span>
          </button>
        </div>

        {tab === 'settings' ? (
          <SettingsPanel orgId={orgId} settings={settings} onSaved={() => void refresh()} />
        ) : (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2 justify-between">
              <div className="seg">
                <button
                  onClick={() => setSevFilter('all')}
                  className={`seg-btn ${sevFilter === 'all' ? 'is-on' : ''}`}
                >
                  All
                </button>
                <button
                  onClick={() => setSevFilter('unauthorized')}
                  className={`seg-btn ${sevFilter === 'unauthorized' ? 'is-on' : ''}`}
                >
                  Unauthorized
                </button>
                {/* Only offer a severity that this channel actually has. */}
                {SEVERITIES.filter((s) => rows.some((r) => r.event_type === tab && r.ai_severity === s)).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSevFilter(s)}
                    className={`seg-btn ${sevFilter === s ? 'is-on' : ''}`}
                  >
                    <span className="inline-flex items-center gap-1.5 capitalize">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: sevTone(s) }} />
                      {s}
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {visible.length > 0 && (
                  <span className="text-[10.5px] t3 tnum">
                    {visible.length} of {countsByType[tab] ?? 0}
                  </span>
                )}
                <label className="field" style={{ minWidth: 210 }}>
                  <i className="ri-search-line text-[12px] t3" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="File, device, agent, reason…"
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

            <EventsTable rows={visible} type={tab} loading={loading} enabled={enabledFor(tab)} />
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
