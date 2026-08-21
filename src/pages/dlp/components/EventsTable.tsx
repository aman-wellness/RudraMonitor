import { useState } from 'react';
import { formatBytes, sevTone, type DlpRow } from '../useDlp';
import EventDetail from './EventDetail';
import Pagination, { usePagination } from '@/pages/monitoring/components/Pagination';

/* One event list, shaped to the type it's showing.

   Columns are chosen per event type instead of one 8-column layout reused for
   every type with headers that swap meaning ("File / From → To", "Size /
   Attachment"). A USB transfer and a webmail attachment share almost nothing,
   and a clipboard event has neither a device nor a recipient — the old table
   showed em-dashes down two whole columns for it. */

const stamp = (iso: string) => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
};

const mailHost = (url: string): string => {
  try { return new URL(url).host; } catch { return url; }
};

function SeverityChip({ row }: { row: DlpRow }) {
  if (!row.ai_severity) {
    // ai_processed_at tells us whether the classifier has run. Without it,
    // "classifying…" was shown forever for events the AI never got to.
    return (
      <span className="text-[10.5px] t3">
        {row.ai_processed_at ? 'unclassified' : 'classifying…'}
      </span>
    );
  }
  const tone = sevTone(row.ai_severity);
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-md capitalize inline-flex items-center gap-1"
      style={{ color: tone, background: 'var(--d-sunken)', border: '1px solid var(--d-line-soft)' }}
    >
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: tone }} />
      {row.ai_severity}
    </span>
  );
}

function AlertCell({ row }: { row: DlpRow }) {
  if (row.alert_sent_at) {
    return (
      <span className="text-[10.5px] t-success inline-flex items-center gap-1" title={`Sent ${stamp(row.alert_sent_at)}${row.alert_email ? ` to ${row.alert_email}` : ''}`}>
        <i className="ri-mail-check-line" />
        sent
      </span>
    );
  }
  if (row.ai_authorized === false) {
    return (
      <span className="text-[10.5px] t-warning inline-flex items-center gap-1" title="Unauthorized — an alert email is due">
        <i className="ri-time-line" />
        queued
      </span>
    );
  }
  return <span className="text-[10.5px] t3">not needed</span>;
}

export default function EventsTable({
  rows,
  type,
  loading,
  enabled,
}: {
  rows: DlpRow[];
  type: string;
  loading: boolean;
  /** Whether this channel is switched on in Settings — shapes the empty state. */
  enabled: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  // Look the detail row up across ALL rows, not just the visible page — a
  // drawer opened from page 3 must not disappear when the page state resets.
  const open = rows.find((r) => r.id === openId) ?? null;

  // useDlp fetches up to 500 events. A day with an active USB or webmail
  // channel fills that easily, and every row is something a reviewer has to
  // read individually rather than skim.
  const { visible, page, pageCount, setPage, from, to, total } = usePagination(rows);

  if (loading && rows.length === 0) {
    return <p className="text-center text-[11px] t3 py-6">Loading…</p>;
  }

  if (rows.length === 0) {
    return (
      <div className="panel p-8 text-center">
        <i className="ri-shield-check-line text-[22px] t3 block mb-2" />
        <p className="text-[12.5px] t2">Nothing captured on this channel</p>
        <p className="text-[11px] t3 mt-1">
          {enabled
            ? 'Monitoring is on — events appear here within seconds of detection.'
            : 'This channel is switched off in Settings, so nothing is being captured.'}
        </p>
      </div>
    );
  }

  const isUsb = type === 'usb_transfer';
  const isMail = type === 'email_attachment';
  // A clipboard event has no file, so a Size column of em-dashes is dead width.
  const hasSize = rows.some((r) => (r.file_size_bytes ?? 0) > 0);

  return (
    <>
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="d-table" style={{ minWidth: isMail ? 900 : 780 }}>
            <thead>
              <tr className="hair-b">
                <th style={{ width: 112 }}>When</th>
                <th style={{ width: 132 }}>Agent</th>
                {isUsb && <th style={{ width: 170 }}>Device</th>}
                {isMail && <th style={{ width: 210 }}>Recipient</th>}
                <th>{isMail ? 'Attachment' : isUsb ? 'File' : 'Detail'}</th>
                {!isMail && hasSize && <th className="text-right" style={{ width: 80 }}>Size</th>}
                <th style={{ width: 96 }}>Severity</th>
                <th style={{ width: 84 }}>Alert</th>
                <th style={{ width: 30 }} />
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.id} onClick={() => setOpenId(e.id)} title="Open evidence">
                  <td className="text-[11px] t3 whitespace-nowrap tnum">{stamp(e.occurred_at)}</td>
                  <td className="text-[11.5px] t2 truncate">{e.agents?.agent_name ?? '—'}</td>

                  {isUsb && (
                    <td className="max-w-[190px]">
                      <span className="text-[11.5px] t1 truncate block" title={e.device_name ?? undefined}>
                        {e.device_name ?? '—'}
                      </span>
                    </td>
                  )}

                  {isMail && (
                    <td className="max-w-[230px]">
                      <span className="text-[11.5px] t1 truncate block" title={e.recipient_email ?? undefined}>
                        {e.recipient_email ?? '—'}
                      </span>
                      {e.mail_provider && (
                        <span className="text-[10px] t3 capitalize">
                          {e.mail_provider}
                          {e.mail_url ? ` · ${mailHost(e.mail_url)}` : ''}
                        </span>
                      )}
                    </td>
                  )}

                  <td className="max-w-[280px]">
                    <span className="text-[11.5px] t2 truncate block" title={e.file_name ?? e.file_path ?? e.active_window ?? undefined}>
                      {e.file_name ?? e.file_path ?? e.active_window ?? '—'}
                    </span>
                    {e.ai_reason && (
                      <span className="text-[10px] t3 truncate block" title={e.ai_reason}>
                        {e.ai_reason}
                      </span>
                    )}
                  </td>

                  {!isMail && hasSize && (
                    <td className="text-right text-[11px] t3 tnum whitespace-nowrap">
                      {e.file_size_bytes ? formatBytes(e.file_size_bytes) : '—'}
                    </td>
                  )}

                  <td><SeverityChip row={e} /></td>
                  <td><AlertCell row={e} /></td>
                  <td className="text-right t3"><i className="ri-arrow-right-s-line text-[13px]" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Pagination
        page={page} pageCount={pageCount} from={from} to={to} total={total}
        onPage={setPage} unit="events"
      />

      {open && <EventDetail row={open} onClose={() => setOpenId(null)} />}
    </>
  );
}
