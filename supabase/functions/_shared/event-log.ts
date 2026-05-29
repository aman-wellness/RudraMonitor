// Append-only audit-trail helper. Every state change in the auto-invoice
// pipeline calls logEvent() so the command-center activity feed renders a
// chronological story. Failures here must never break the caller — log
// and swallow.

import { adminClient } from "./crypto.ts";

export type EventKind =
  | "job_queued" | "job_started" | "job_completed" | "job_failed"
  | "tier_api_pulled" | "tier_email_received" | "tier_scrape_started"
  | "needs_otp" | "otp_received" | "otp_expired"
  | "pdf_saved" | "forwarded" | "forward_skipped" | "forward_failed"
  | "cron_tick" | "channel_ping_sent" | "channel_ping_failed"
  | "silent_failure_alert";

export interface LogEvent {
  orgId: string;
  credentialId?: string | null;
  jobId?: string | null;
  invoiceId?: string | null;
  kind: EventKind;
  actor?: string | null;       // 'cron' | 'dispatcher' | 'worker' | 'webhook' | 'admin:<uid>'
  channel?: string | null;     // 'slack' | 'teams' | …
  message?: string | null;
  detail?: Record<string, unknown>;
}

export async function logEvent(e: LogEvent): Promise<void> {
  try {
    const admin = adminClient();
    await admin.from("invoice_fetch_events").insert({
      org_id: e.orgId,
      credential_id: e.credentialId ?? null,
      job_id: e.jobId ?? null,
      invoice_id: e.invoiceId ?? null,
      kind: e.kind,
      actor: e.actor ?? null,
      channel: e.channel ?? null,
      message: e.message ?? null,
      detail: e.detail ?? {},
    });
  } catch (err) {
    // Best-effort. Never propagate.
    console.warn("logEvent failed:", (err as Error).message, e.kind);
  }
}
