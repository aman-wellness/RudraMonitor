// Shared helper used by every otp-inbound-<channel> webhook. Takes a
// (orgId, externalUserId, messageText, channel) tuple, finds the most
// recent pending otp_request for the org, parses a 4-8 digit code out of
// the message, attributes to a Rudrans user via org_otp_admin_links
// (when present), and fulfills the request.
//
// Channels can call this with a partial messageText — the regex grabs any
// 4-8 digit run, ignoring spaces and dashes ("123 456" / "123-456").

import { adminClient } from "./crypto.ts";
import { logEvent } from "./event-log.ts";

export interface InboundResult {
  ok: boolean;
  request_id?: string;
  responded_via?: string;
  note?: string;
}

export async function ingestInbound(opts: {
  orgId: string;
  externalUserId: string | null;
  channel: "teams" | "slack" | "google_chat" | "whatsapp";
  messageText: string;
}): Promise<InboundResult> {
  const code = extractCode(opts.messageText);
  if (!code) return { ok: false, note: "no 4-8 digit code found in message" };

  const admin = adminClient();
  await admin.rpc("otp_requests_expire_stale").catch(() => null);

  const { data: r } = await admin
    .from("otp_requests")
    .select("id, status, job_id, expires_at")
    .eq("org_id", opts.orgId)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!r) return { ok: false, note: "no pending OTP request for this org" };

  // Resolve responder via org_otp_admin_links (best-effort).
  let respondedBy: string | null = null;
  if (opts.externalUserId) {
    const { data: link } = await admin
      .from("org_otp_admin_links")
      .select("user_id")
      .eq("org_id", opts.orgId)
      .eq("provider", opts.channel)
      .eq("external_id", opts.externalUserId)
      .maybeSingle();
    respondedBy = link?.user_id ?? null;
  }

  const { error: upErr } = await admin
    .from("otp_requests")
    .update({
      status: "fulfilled",
      response: code,
      responded_by: respondedBy,
      responded_via: opts.channel,
      fulfilled_at: new Date().toISOString(),
    })
    .eq("id", r.id)
    .eq("status", "pending");
  if (upErr) return { ok: false, note: `update: ${upErr.message}` };

  await admin.from("invoice_fetch_jobs")
    .update({ status: "running" })
    .eq("id", r.job_id)
    .eq("status", "needs_otp");

  await logEvent({
    orgId: opts.orgId, jobId: r.job_id,
    kind: "otp_received", actor: "webhook", channel: opts.channel,
    message: `OTP received via ${opts.channel}${respondedBy ? "" : " (unattributed reply)"}`,
  });

  return { ok: true, request_id: r.id, responded_via: opts.channel };
}

export function extractCode(text: string): string | null {
  if (!text) return null;
  // Look for the longest 4-8 digit run, ignoring common separators.
  const cleaned = text.replace(/[\s\-]/g, "");
  const m = cleaned.match(/\b\d{4,8}\b/);
  return m ? m[0] : null;
}
