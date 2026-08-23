import { useEffect, useState } from 'react';
import { eventTypeLabel, formatBytes, sevTone, type DlpRow } from '../useDlp';
import { notify } from '@/lib/notify';
import { supabase } from '@/lib/supabase';

/* Everything the agent captured about one event.

   dlp_events stores 28 columns; the table showed eight. The file hash, device
   serial, active window, mail URL, direction, classifying model and the alert
   recipient were all being written and never displayed — which is exactly the
   evidence someone investigating an incident needs. This is a read-only view of
   the row, so it costs no extra query. */

const stampFull = (iso: string | null) => {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
};

function Row({ label, value, mono, copy }: { label: string; value: string | null | undefined; mono?: boolean; copy?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 hair-b last:border-b-0">
      <span className="label flex-shrink-0 pt-0.5">{label}</span>
      <span className="flex items-start gap-1.5 min-w-0">
        <span className={`text-[11.5px] t1 break-all text-right ${mono ? 'font-mono' : ''}`}>{value}</span>
        {copy && (
          <button
            onClick={() => {
              void navigator.clipboard.writeText(value);
              notify.success('Copied', { description: label });
            }}
            className="icon-btn flex-shrink-0"
            title={`Copy ${label.toLowerCase()}`}
          >
            <i className="ri-clipboard-line" />
          </button>
        )}
      </span>
    </div>
  );
}

export default function EventDetail({ row, onClose }: { row: DlpRow; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tone = sevTone(row.ai_severity);
  const authorized = row.ai_authorized;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-end"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-md overflow-y-auto"
        style={{ background: 'var(--d-panel)', borderLeft: '1px solid var(--d-line)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="DLP event evidence"
      >
        <header className="sticky top-0 z-10 px-3.5 py-2.5 hair-b flex items-start justify-between gap-3"
          style={{ background: 'var(--d-panel)' }}>
          <div className="min-w-0">
            <p className="text-[13px] t1 font-medium">{eventTypeLabel(row.event_type)}</p>
            <p className="text-[10.5px] t3">{stampFull(row.occurred_at)}</p>
          </div>
          <button onClick={onClose} className="icon-btn flex-shrink-0" aria-label="Close">
            <i className="ri-close-line" />
          </button>
        </header>

        <div className="p-3.5 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {row.ai_severity && (
              <span
                className="text-[10.5px] px-2 py-1 rounded-md capitalize inline-flex items-center gap-1.5"
                style={{ color: tone, background: 'var(--d-sunken)', border: '1px solid var(--d-line-soft)' }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: tone }} />
                {row.ai_severity} severity
              </span>
            )}
            {authorized !== null && (
              <span className={`chip text-[10.5px] ${authorized ? 'chip-success' : 'chip-danger'}`}>
                <i className={authorized ? 'ri-check-line' : 'ri-close-circle-line'} />
                {authorized ? 'Authorized' : 'Unauthorized'}
              </span>
            )}
          </div>

          {row.ai_reason && (
            <div className="sunken rounded-lg p-2.5">
              <p className="label mb-1">Why the classifier flagged it</p>
              <p className="text-[11.5px] t2 leading-relaxed">{row.ai_reason}</p>
            </div>
          )}

          <section>
            <p className="label mb-1">Event</p>
            <Row label="Agent" value={row.agents?.agent_name} />
            <Row label="Direction" value={row.direction?.replace(/_/g, ' ')} />
            <Row label="Active window" value={row.active_window} />
            <Row label="Device" value={row.device_name} />
            <Row label="Device type" value={row.device_type} />
            <Row label="Serial" value={row.device_serial} mono copy />
          </section>

          {(row.file_name || row.file_path || row.file_size_bytes || row.file_hash_sha256) && (
            <section>
              <p className="label mb-1">File</p>
              <Row label="Name" value={row.file_name} />
              <Row label="Path" value={row.file_path} mono />
              <Row label="Size" value={row.file_size_bytes ? formatBytes(row.file_size_bytes) : null} />
              <Row label="Type" value={row.file_mime} mono />
              <Row label="SHA-256" value={row.file_hash_sha256} mono copy />
            </section>
          )}

          {(row.sender_email || row.recipient_email || row.mail_provider || row.mail_url) && (
            <section>
              <p className="label mb-1">Mail</p>
              <Row label="Provider" value={row.mail_provider} />
              <Row label="From" value={row.email_send?.from_address ?? row.sender_email} copy />
              {row.email_send ? (
                <>
                  <Row label="To" value={row.email_send.to_recipients.join(', ') || null} copy />
                  <Row label="Cc" value={row.email_send.cc_recipients.join(', ') || null} copy />
                  <Row label="Bcc" value={row.email_send.bcc_recipients.join(', ') || null} copy />
                </>
              ) : (
                <Row label="To" value={row.recipient_email} copy />
              )}
              <Row label="URL" value={row.mail_url} mono />
            </section>
          )}

          {row.email_send && (
            <>
              <EmailBodySection subject={row.email_send.subject} bodyText={row.email_send.body_text} bodyHtml={row.email_send.body_html} />
              {row.email_send.attachments.length > 0 && (
                <AttachmentsSection attachments={row.email_send.attachments} />
              )}
            </>
          )}

          {/* Only when there's something to put in it — otherwise this was a
              heading over four suppressed rows. */}
          {(row.ai_model || row.ai_processed_at || row.alert_sent_at || row.alert_email
            || (!row.alert_sent_at && row.ai_authorized === false)) && (
          <section>
            <p className="label mb-1">Classification &amp; alert</p>
            <Row label="Model" value={row.ai_model} mono />
            <Row label="Classified" value={stampFull(row.ai_processed_at)} />
            <Row label="Alert sent" value={stampFull(row.alert_sent_at)} />
            <Row label="Alert to" value={row.alert_email} />
            {!row.alert_sent_at && row.ai_authorized === false && (
              <p className="text-[10.5px] t-warning mt-1.5">
                <i className="ri-time-line mr-1" />
                No alert email recorded for this unauthorized event yet.
              </p>
            )}
          </section>
          )}
        </div>
      </aside>
    </div>
  );
}

/** Subject + body preview for a full-email intercept row.
 *  Body HTML is sandbox-rendered into an iframe with srcdoc so no
 *  navigation, script, or network request from the captured email can
 *  reach the surrounding dashboard. Plain-text fallback shows when the
 *  agent captured only body_text or the org disabled body capture. */
function EmailBodySection({
  subject, bodyText, bodyHtml,
}: { subject: string | null; bodyText: string | null; bodyHtml: string | null }) {
  const [showHtml, setShowHtml] = useState(true);
  return (
    <section>
      <p className="label mb-1">Message</p>
      <Row label="Subject" value={subject} copy />
      {(bodyHtml || bodyText) && (
        <div className="sunken rounded-lg p-2.5 mt-2">
          <div className="flex items-center justify-between mb-1.5">
            <p className="label">Body</p>
            {bodyHtml && bodyText && (
              <button
                onClick={() => setShowHtml((v) => !v)}
                className="text-[10.5px] t-accent hover:underline"
              >
                {showHtml ? 'View plain text' : 'View HTML'}
              </button>
            )}
          </div>
          {showHtml && bodyHtml ? (
            <iframe
              title="Email body"
              sandbox=""
              srcDoc={bodyHtml}
              className="w-full rounded"
              style={{ minHeight: 200, background: 'var(--d-panel)', border: '1px solid var(--d-line-soft)' }}
            />
          ) : (
            <pre className="text-[11.5px] t2 whitespace-pre-wrap break-words leading-relaxed">
              {bodyText ?? '(body not captured — org policy has body_capture=false)'}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

/** Attachment list with signed-URL download buttons.
 *  Signed URL is minted on click so links don't sit stale in the DOM;
 *  each is single-use over 5 minutes, which is enough for the admin's
 *  browser to actually start the download. */
function AttachmentsSection({
  attachments,
}: {
  attachments: Array<{ id: string; file_name: string; file_size_bytes: number; file_mime: string | null; storage_path: string }>;
}) {
  const download = async (path: string, name: string) => {
    const { data, error } = await supabase.storage
      .from('dlp-email-attachments')
      .createSignedUrl(path, 300, { download: name });
    if (error || !data) {
      notify.error('Download failed', { description: error?.message ?? 'no signed url' });
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener');
  };
  return (
    <section>
      <p className="label mb-1">Attachments ({attachments.length})</p>
      <div className="space-y-1.5">
        {attachments.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-2 sunken rounded-md px-2.5 py-1.5">
            <div className="min-w-0">
              <p className="text-[11.5px] t1 truncate" title={a.file_name}>{a.file_name}</p>
              <p className="text-[10px] t3">{formatBytes(a.file_size_bytes)} · {a.file_mime ?? 'unknown type'}</p>
            </div>
            <button
              onClick={() => void download(a.storage_path, a.file_name)}
              className="icon-btn flex-shrink-0"
              title="Download attachment"
            >
              <i className="ri-download-line" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
