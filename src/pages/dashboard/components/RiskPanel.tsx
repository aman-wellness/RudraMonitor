import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAlerts, useDlpRisk } from '@/lib/dataHooks';
import { useRefreshOnTick } from '../refreshBus';
import { useFilterWindow } from '../filterContext';
import { EmptyNote, MicroLabel, Panel, Segmented } from './ui';
import { C } from './chartKit';
import { kindColor, prettyKind } from '@/lib/labels';

/* Security + operational risk, in the order an owner triages it.

   DLP first (data leaving the company is the expensive kind of problem), then
   the alert feed. One panel because both answer the same question — "is
   anything on fire?" — and splitting them made the page longer without making
   it clearer. */

type Tab = 'dlp' | 'alerts';

/* Four distinct hues, hottest first. Reusing amber for both medium and high
   made them read as one bucket; reusing danger with an opacity made "high"
   look like a faded critical rather than its own level. */
const SEVERITIES = [
  { key: 'critical', label: 'Critical', color: C.danger },
  { key: 'high', label: 'High', color: C.sevHigh },
  { key: 'medium', label: 'Medium', color: C.warning },
  { key: 'low', label: 'Low', color: C.neutral },
] as const;

const EVENT_LABEL: Record<string, string> = {
  usb_transfer: 'USB transfer',
  email_attachment: 'Email attachment',
  clipboard_exfil: 'Clipboard copy',
};

const relative = (iso: string) => {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
};

export default function RiskPanel({ index = 0 }: { index?: number }) {
  const [tab, setTab] = useState<Tab>('dlp');
  const w = useFilterWindow();
  const { events, summary, loading: dlpLoading, refresh: refreshDlp } = useDlpRisk(
    w.sinceHours, w.untilHours, w.agentId,
  );
  const {
    rows: alertRows,
    loading: alertsLoading,
    refresh: refreshAlerts,
  } = useAlerts({
    sinceHours: w.sinceHours,
    untilHours: w.untilHours,
    agentId: w.agentId,
    limit: 20,
  });
  useRefreshOnTick(refreshDlp, refreshAlerts);

  const unresolved = alertRows.filter((a) => !a.ai_resolved);
  const classified = SEVERITIES.reduce((s, sev) => s + summary.counts[sev.key], 0);

  return (
    <Panel
      title="Risk & alerts"
      index={index}
      action={
        <Segmented
          value={tab}
          options={[
            { id: 'dlp', label: `DLP ${summary.current}` },
            { id: 'alerts', label: `Alerts ${unresolved.length}` },
          ]}
          onChange={setTab}
        />
      }
    >
      {tab === 'dlp' ? (
        dlpLoading && events.length === 0 ? (
          <EmptyNote title="Loading…" />
        ) : summary.current === 0 ? (
          <EmptyNote
            title={`No data-loss events in ${w.label.toLowerCase()}`}
            hint="USB transfers, email attachments and clipboard copies land here."
          />
        ) : (
          <>
            <div>
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <MicroLabel>Severity mix · {w.label}</MicroLabel>
                <span className="text-[10.5px] t3 tnum">
                  <span className="t1 font-medium">{summary.serious}</span> high or critical
                </span>
              </div>

              <span className="stack" style={{ height: 8 }}>
                {SEVERITIES.map((s) => {
                  const n = summary.counts[s.key];
                  return (
                    <i
                      key={s.key}
                      style={{
                        flexBasis: classified > 0 ? `${(n / classified) * 100}%` : '0%',
                        background: s.color,
                      }}
                      title={`${s.label}: ${n}`}
                    />
                  );
                })}
              </span>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2">
                {SEVERITIES.map((s) => {
                  const n = summary.counts[s.key];
                  return (
                    <span key={s.key} className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: s.color, opacity: n > 0 ? 1 : 0.35 }}
                      />
                      <span className="text-[10px] t3 flex-1 truncate">{s.label}</span>
                      <span
                        className={`text-[10.5px] tnum flex-shrink-0 ${n > 0 ? 't1 font-medium' : 't3'}`}
                      >
                        {n}
                      </span>
                    </span>
                  );
                })}
              </div>

              {summary.counts.unclassified > 0 && (
                <p className="text-[9.5px] t3 mt-2">
                  {summary.counts.unclassified} awaiting AI classification
                </p>
              )}
            </div>

            <div className="mt-auto pt-2.5 hair-t">
              <MicroLabel className="mb-1.5">Most recent</MicroLabel>
              <div className="space-y-2">
                {events.slice(0, 3).map((e) => (
                  <Link
                    key={e.id}
                    to="/dlp"
                    className="flex items-start gap-2.5 group"
                    title={e.file_name ?? undefined}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                      style={{
                        background:
                          e.severity === 'critical' || e.severity === 'high'
                            ? C.danger
                            : e.severity === 'medium'
                              ? C.warning
                              : C.info,
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] t2 truncate group-hover:underline">
                        {EVENT_LABEL[e.event_type] ?? e.event_type}
                        {e.file_name ? ` · ${e.file_name}` : ''}
                      </span>
                      <span className="block text-[9.5px] t3 truncate">
                        {e.agent_name || 'Unknown agent'} · {relative(e.occurred_at)} ago
                        {e.authorized === false ? ' · unauthorised' : ''}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </>
        )
      ) : alertsLoading && alertRows.length === 0 ? (
        <EmptyNote title="Loading…" />
      ) : alertRows.length === 0 ? (
        <EmptyNote title={`No alerts in ${w.label.toLowerCase()}`} />
      ) : (
        <>
          <div className="space-y-2">
            {alertRows.slice(0, 5).map((a) => (
              <Link key={a.id} to="/alerts" className="flex items-start gap-2.5 group">
                {/* Dot coloured by the alert's KIND (derived, see lib/labels).
                    The three-way icon this replaces branched on 'error' /
                    'warning', values the column never holds, so every alert
                    rendered as the same blue info icon. */}
                <span
                  className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                  style={{ background: kindColor(a.alert_type) }}
                  title={prettyKind(a.alert_type)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] t2 leading-snug line-clamp-2 group-hover:underline">
                    {a.message}
                  </span>
                  <span className="block text-[9.5px] t3 truncate">
                    {a.agent_name || 'Unknown agent'} · {relative(a.created_at)} ago
                    {a.ai_resolved ? ' · resolved' : ''}
                  </span>
                </span>
              </Link>
            ))}
          </div>
          <Link to="/alerts" className="mt-auto pt-2.5 hair-t text-[9.5px] t-accent hover:underline">
            View all alerts →
          </Link>
        </>
      )}
    </Panel>
  );
}
