// POST /functions/v1/invoice-job-complete
// Headers: Authorization: Bearer <SERVICE_ROLE_KEY> (worker only)
// Body:    {
//   job_id: string,
//   outcome: 'success' | 'failed' | 'needs_human' | 'needs_otp_timeout',
//   error?: string,
//
//   // success payload (any may be omitted):
//   invoice?: {
//     invoice_number?: string,
//     issue_date?: string,         // YYYY-MM-DD
//     period_start?: string,
//     period_end?: string,
//     amount?: number,
//     currency?: string,
//     status?: 'paid'|'pending'|'overdue'|'failed'|'refunded'|'draft',
//     pdf_base64?: string,         // raw PDF bytes; uploaded to bucket
//     pdf_filename?: string
//   },
//
//   // optional cookie persistence: if the worker logged in OK, dump the
//   // cookie jar so next month's run can skip the OTP screen.
//   session_cookies?: string       // JSON string of cookies array
// }
//
// On success: uploads PDF (if any) to `credential-invoices` bucket, inserts
// a credential_invoices row (source='scrape'), closes the job. The DB
// trigger from migration 0084 then auto-forwards to accounts_recipient_emails.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { encrypt } from "../_shared/crypto.ts";
import { logEvent } from "../_shared/event-log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface CompleteBody {
  job_id?: string;
  outcome?: "success" | "failed" | "needs_human" | "needs_otp_timeout";
  error?: string;
  invoice?: {
    invoice_number?: string;
    issue_date?: string;
    period_start?: string;
    period_end?: string;
    amount?: number;
    currency?: string;
    status?: "paid" | "pending" | "overdue" | "failed" | "refunded" | "draft";
    pdf_base64?: string;
    pdf_filename?: string;
  };
  session_cookies?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ") || auth.slice(7).trim() !== SERVICE_ROLE_KEY) {
    return json({ error: "service role required" }, 401);
  }

  let body: CompleteBody;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const jobId = (body.job_id ?? "").trim();
  if (!jobId) return json({ error: "job_id required" }, 400);
  if (!body.outcome) return json({ error: "outcome required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: job } = await admin
    .from("invoice_fetch_jobs")
    .select("id, org_id, credential_id, billing_period_start, billing_period_end, attempts")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return json({ error: "job not found" }, 404);

  // Persist session cookies on any path (even failed runs sometimes leave a
  // usable post-login state). Encrypt before storing.
  if (typeof body.session_cookies === "string" && body.session_cookies.length > 0) {
    try {
      const cipher = await encrypt(body.session_cookies, "CRED_VAULT_ENC_KEY");
      await admin.from("credentials").update({ session_cookies_enc: cipher }).eq("id", job.credential_id);
    } catch (e) {
      // Non-fatal — log and move on.
      console.warn("cookie persist failed:", (e as Error).message);
    }
  }

  if (body.outcome !== "success") {
    await admin.from("invoice_fetch_jobs").update({
      status: body.outcome,
      last_error: body.error ?? null,
      attempts: (job.attempts ?? 0) + 1,
      completed_at: new Date().toISOString(),
      locked_by: null,
      locked_at: null,
    }).eq("id", jobId);
    await logEvent({
      orgId: job.org_id, credentialId: job.credential_id, jobId,
      kind: "job_failed", actor: "worker",
      message: `Scrape ${body.outcome}: ${body.error ?? ""}`,
      detail: { outcome: body.outcome, error: body.error },
    });
    return json({ ok: true }, 200);
  }

  // --- success path ---
  const inv = body.invoice ?? {};
  const invoiceId = crypto.randomUUID();
  let attachmentPath: string | null = null;

  if (inv.pdf_base64) {
    const bytes = b64ToBytes(inv.pdf_base64);
    const filename = inv.pdf_filename || `${invoiceId}.pdf`;
    const path = `${job.org_id}/${job.credential_id}/${invoiceId}.pdf`;
    const { error: upErr } = await admin.storage.from("credential-invoices").upload(path, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (upErr) {
      await admin.from("invoice_fetch_jobs").update({
        status: "failed",
        last_error: `pdf upload: ${upErr.message}`,
        completed_at: new Date().toISOString(),
      }).eq("id", jobId);
      return json({ error: `pdf upload: ${upErr.message}` }, 500);
    }
    attachmentPath = path;
    void filename;
  }

  const { error: insErr } = await admin.from("credential_invoices").insert({
    id: invoiceId,
    org_id: job.org_id,
    credential_id: job.credential_id,
    external_id: `scrape:${invoiceId}`,
    invoice_number: inv.invoice_number ?? null,
    issue_date: inv.issue_date ?? job.billing_period_end,
    period_start: inv.period_start ?? job.billing_period_start,
    period_end: inv.period_end ?? job.billing_period_end,
    amount: inv.amount ?? null,
    currency: inv.currency ?? null,
    status: inv.status ?? "pending",
    source: "scrape",
    attachment_path: attachmentPath,
    attachment_mime: attachmentPath ? "application/pdf" : null,
    attachment_name: inv.pdf_filename ?? null,
  });
  if (insErr) {
    await admin.from("invoice_fetch_jobs").update({
      status: "failed",
      last_error: `invoice insert: ${insErr.message}`,
      completed_at: new Date().toISOString(),
    }).eq("id", jobId);
    return json({ error: `invoice insert: ${insErr.message}` }, 500);
  }

  await admin.from("invoice_fetch_jobs").update({
    status: "success",
    result_invoice_id: invoiceId,
    last_error: null,
    completed_at: new Date().toISOString(),
    locked_by: null,
    locked_at: null,
  }).eq("id", jobId);

  await admin.from("credentials").update({
    last_fetch_attempt_at: new Date().toISOString(),
  }).eq("id", job.credential_id);

  await logEvent({
    orgId: job.org_id, credentialId: job.credential_id, jobId, invoiceId,
    kind: "pdf_saved", actor: "worker",
    message: `Invoice PDF saved (scrape)`,
    detail: { invoice_number: inv.invoice_number, amount: inv.amount, currency: inv.currency },
  });

  return json({ ok: true, invoice_id: invoiceId }, 200);
});

function b64ToBytes(b64: string): Uint8Array {
  const pure = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(pure);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
