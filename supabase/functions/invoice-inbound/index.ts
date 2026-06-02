// POST /functions/v1/invoice-inbound
// Webhook receiver for inbound-email providers (Resend Inbound / Postmark /
// SendGrid Inbound Parse). Customer sets their per-org invoice forwarding
// address (`inv-<orgid>@invoices.wellnessextract.com`) as the billing email on each
// SaaS platform. When the platform mails the monthly invoice PDF, the
// provider POSTs it here.
//
// We accept a normalised JSON payload (works for all three providers with
// a thin shim on the email-provider side — payload mapping documented in
// docs/invoice-inbound-payload.md).
//
// Body shape (after normalising):
//   {
//     to: string,                   // "inv-<orgid>@invoices.wellnessextract.com"
//     from: string,                 // "billing@razorpay.com"
//     subject: string,
//     received_at: string,
//     attachments: [{
//       filename: string,
//       content_type: string,
//       base64: string              // raw PDF bytes
//     }]
//   }
//
// Auth: the inbound provider POSTs with `x-inbound-token` matching
// integrations.INBOUND_EMAIL_TOKEN (set in Admin → Integrations).
//
// On success: uploads the PDF to the `invoices` bucket, inserts a
// credential_invoices row (source='email'), and closes any matching open
// invoice_fetch_jobs row for that credential's current period.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegration } from "../_shared/integrations.ts";
import { logEvent } from "../_shared/event-log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Attachment { filename: string; content_type: string; base64: string }
interface InboundBody {
  to?: string;
  from?: string;
  subject?: string;
  received_at?: string;
  attachments?: Attachment[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const expected = await getIntegration("INBOUND_EMAIL_TOKEN").catch(() => "");
  const got = req.headers.get("x-inbound-token") ?? "";
  if (!expected || got !== expected) return json({ error: "unauthorized" }, 401);

  let body: InboundBody;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const to = (body.to ?? "").toLowerCase().trim();
  const from = (body.from ?? "").toLowerCase().trim();
  if (!to) return json({ error: "missing `to`" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve org from either short slug or legacy full UUID:
  //   • new: inv-<8-hex-slug>@…       → look up by organizations.invoice_inbound_slug
  //   • old: inv-<full-org-uuid>@…    → look up by organizations.id (back-compat for
  //                                      platforms already configured with the long address)
  const orgId = await resolveInboundOrg(admin, to);
  if (!orgId) return json({ error: "unrecognised inbound address" }, 400);

  const pdfs = (body.attachments ?? []).filter(
    (a) => a.content_type?.toLowerCase().includes("pdf")
      || a.filename?.toLowerCase().endsWith(".pdf"),
  );
  if (pdfs.length === 0) return json({ error: "no PDF attachment" }, 400);

  // Pick the candidate credential by sender-domain heuristic.
  const senderDomain = from.split("@").pop() ?? "";
  const credId = await pickCredential(admin, orgId, senderDomain, body.subject ?? "");
  if (!credId) {
    return json({
      error: `no matching credential for sender domain ${senderDomain} in org ${orgId}`,
    }, 404);
  }

  const created: string[] = [];
  for (const att of pdfs) {
    const bytes = b64ToBytes(att.base64);
    const invoiceId = crypto.randomUUID();
    const path = `${orgId}/${credId}/${invoiceId}.pdf`;

    const { error: upErr } = await admin.storage.from("credential-invoices").upload(path, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (upErr) return json({ error: `storage: ${upErr.message}` }, 500);

    // Try to parse an invoice number from the subject. Falls back to null.
    const invNumber = guessInvoiceNumber(body.subject ?? "", att.filename);
    const issueDate = (body.received_at ?? new Date().toISOString()).slice(0, 10);

    const { error: insErr } = await admin.from("credential_invoices").insert({
      id: invoiceId,
      org_id: orgId,
      credential_id: credId,
      external_id: `email:${invoiceId}`,
      invoice_number: invNumber,
      issue_date: issueDate,
      status: "pending",
      source: "email",
      attachment_path: path,
      attachment_mime: "application/pdf",
      attachment_name: att.filename,
      raw: { from, subject: body.subject, filename: att.filename },
    });
    if (insErr) return json({ error: `insert: ${insErr.message}` }, 500);
    created.push(invoiceId);

    await logEvent({
      orgId, credentialId: credId, invoiceId,
      kind: "tier_email_received", actor: "webhook",
      message: `Inbound email from ${from}: PDF saved`,
      detail: { from, subject: body.subject, filename: att.filename },
    });

    // Close any open job for this credential's current period.
    await admin
      .from("invoice_fetch_jobs")
      .update({
        status: "success",
        result_invoice_id: invoiceId,
        completed_at: new Date().toISOString(),
      })
      .eq("credential_id", credId)
      .in("status", ["queued", "running", "needs_otp"])
      .lte("billing_period_start", issueDate);
  }

  await admin.from("credentials").update({
    last_fetch_attempt_at: new Date().toISOString(),
  }).eq("id", credId);

  return json({ ok: true, credential_id: credId, invoices: created }, 200);
});

// ── Credential picker ────────────────────────────────────────────────────
// Strategy: match credentials in the org whose login_url host contains a
// recognisable token from the sender domain, e.g. billing@razorpay.com →
// credentials with login_url like *razorpay.com*. Falls back to subject
// keyword match against platform_name.
async function pickCredential(
  admin: ReturnType<typeof createClient>,
  orgId: string,
  senderDomain: string,
  subject: string,
): Promise<string | null> {
  const baseDomain = senderDomain.split(".").slice(-2).join(".");  // razorpay.com from billing.razorpay.com
  const { data } = await admin
    .from("credentials")
    .select("id, platform_name, login_url")
    .eq("org_id", orgId)
    .eq("active", true);
  if (!data?.length) return null;

  // 1. Match by login_url containing the sender's base domain.
  const byDomain = data.find((c) => (c.login_url ?? "").toLowerCase().includes(baseDomain));
  if (byDomain) return byDomain.id;

  // 2. Match by platform_name appearing in sender domain or subject.
  const subj = subject.toLowerCase();
  const byName = data.find((c) => {
    const name = (c.platform_name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!name) return false;
    return baseDomain.includes(name) || subj.includes(name);
  });
  return byName?.id ?? null;
}

function guessInvoiceNumber(subject: string, filename: string): string | null {
  const re = /(inv[-_# ]?|invoice[-_# ]?)([a-z0-9-]{4,})/i;
  const fromSubject = subject.match(re);
  if (fromSubject) return fromSubject[2];
  const fromFile = filename.match(re);
  if (fromFile) return fromFile[2];
  return null;
}

function b64ToBytes(b64: string): Uint8Array {
  // Strip data URI prefix if present.
  const pure = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(pure);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Pull the org id out of an inbound `inv-XXXX@invoices.wellnessextract.com` address.
// New format: 8-hex-char slug (migration 0096) — looked up via
// `organizations.invoice_inbound_slug`.
// Legacy format: full 36-char UUID — looked up via `organizations.id`.
// Returns null if the address doesn't match either form or no org owns it.
// deno-lint-ignore no-explicit-any
async function resolveInboundOrg(admin: any, to: string): Promise<string | null> {
  const local = to.match(/^inv-([a-z0-9-]+)@/i)?.[1]?.toLowerCase();
  if (!local) return null;

  // Slug path — 8 chars, hex only.
  if (/^[0-9a-f]{8}$/.test(local)) {
    const { data } = await admin
      .from("organizations").select("id").eq("invoice_inbound_slug", local).maybeSingle();
    if (data?.id) return data.id as string;
    // fall through to UUID check below — extremely unlikely but a slug
    // could collide with the first 8 hex chars of an old UUID.
  }
  // Legacy UUID path.
  if (/^[0-9a-f-]{36}$/.test(local)) {
    const { data } = await admin
      .from("organizations").select("id").eq("id", local).maybeSingle();
    if (data?.id) return data.id as string;
  }
  return null;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
