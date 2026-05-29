// POST /functions/v1/invoice-forward-accounts
// Body: { invoice_id: string }
//
// Sends the invoice PDF + key details to the org's accounts_recipient_emails
// list. Called either by:
//   • the DB trigger on credential_invoices INSERT (via pg_net)
//   • manually from the UI to re-send a specific invoice
//
// Auth: service-role for the trigger path; user JWT for the UI path.
//
// Email body: short summary + the PDF either attached (when stored locally
// in the invoices bucket via pdf_path) or linked (when external pdf_url).
// Subject: "[Auto-invoice] <platform_name> — <invoice_number or period>".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logEvent } from "../_shared/event-log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = bearer(req);
  if (!jwt) return json({ error: "missing token" }, 401);

  let body: { invoice_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const invoiceId = (body.invoice_id ?? "").trim();
  if (!invoiceId) return json({ error: "invoice_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: inv } = await admin
    .from("credential_invoices")
    .select("id, org_id, credential_id, invoice_number, issue_date, period_start, period_end, amount, currency, status, source, pdf_url, attachment_path, forwarded_at")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return json({ error: "invoice not found" }, 404);

  // Authorise: service-role passes; user JWT must belong to invoice's org.
  const isServiceRole = jwt === SERVICE_ROLE_KEY;
  if (!isServiceRole) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return json({ error: "invalid token" }, 401);
    const { data: mem } = await admin.from("org_members").select("org_id")
      .eq("user_id", u.user.id).eq("org_id", inv.org_id);
    if (!mem?.length) return json({ error: "not authorised for this org" }, 403);
  }

  const [{ data: cred }, { data: org }] = await Promise.all([
    admin.from("credentials").select("platform_name, login_url, billing_cycle, price_amount, price_currency").eq("id", inv.credential_id).maybeSingle(),
    admin.from("organizations").select("name, accounts_recipient_emails").eq("id", inv.org_id).maybeSingle(),
  ]);

  const recipients = (org?.accounts_recipient_emails ?? []).filter((s: string) => !!s && s.includes("@"));
  if (!recipients.length) return json({ error: "no accounts_recipient_emails configured for this org" }, 400);

  // Idempotency: don't double-send if already forwarded.
  if (inv.forwarded_at) {
    return json({ ok: true, skipped: "already_forwarded", forwarded_at: inv.forwarded_at }, 200);
  }

  // Resolve PDF: signed URL if stored locally, else external pdf_url.
  let pdfLink = inv.pdf_url ?? "";
  if (!pdfLink && inv.attachment_path) {
    const { data: signed } = await admin.storage.from("credential-invoices")
      .createSignedUrl(inv.attachment_path, 60 * 60 * 24 * 7);  // 7 days
    pdfLink = signed?.signedUrl ?? "";
  }

  const subject = `[Auto-invoice] ${cred?.platform_name ?? "platform"} — ${
    inv.invoice_number ?? inv.issue_date ?? inv.id.slice(0, 8)
  }`;
  const html = renderEmail({
    orgName: org?.name ?? "",
    platform: cred?.platform_name ?? "",
    loginUrl: cred?.login_url ?? "",
    invoiceNumber: inv.invoice_number,
    issueDate: inv.issue_date,
    periodStart: inv.period_start,
    periodEnd: inv.period_end,
    amount: inv.amount,
    currency: inv.currency,
    status: inv.status,
    pdfLink,
    source: inv.source,
  });

  // Lazy import to avoid loading on every cold start.
  const { sendGraphEmail } = await import("../_shared/graph-email.ts");
  const r = await sendGraphEmail({
    to: recipients,
    subject,
    html,
    orgId: inv.org_id,
  });
  if (!r.ok) {
    await logEvent({
      orgId: inv.org_id, credentialId: inv.credential_id, invoiceId,
      kind: "forward_failed", actor: "trigger",
      message: `Email send failed: ${r.error}`,
      detail: { recipients, error: r.error },
    });
    return json({ error: `send: ${r.error}` }, 502);
  }

  // Mark forwarded so we don't double-send (idempotency).
  await admin.from("credential_invoices").update({
    forwarded_at: new Date().toISOString(),
    forwarded_to: recipients,
  }).eq("id", invoiceId);

  await logEvent({
    orgId: inv.org_id, credentialId: inv.credential_id, invoiceId,
    kind: "forwarded", actor: "trigger",
    message: `Forwarded to ${recipients.length} accounts recipient${recipients.length === 1 ? "" : "s"}`,
    detail: { recipients, from: r.sentFrom },
  });

  return json({ ok: true, sent_to: recipients, sent_from: r.sentFrom }, 200);
});

function renderEmail(p: {
  orgName: string; platform: string; loginUrl: string;
  invoiceNumber: string | null; issueDate: string | null;
  periodStart: string | null; periodEnd: string | null;
  amount: number | null; currency: string | null; status: string;
  pdfLink: string; source: string;
}): string {
  const amountStr = p.amount != null
    ? `${p.currency ?? ""} ${Number(p.amount).toLocaleString()}`
    : "—";
  const period = p.periodStart && p.periodEnd ? `${p.periodStart} → ${p.periodEnd}` : (p.issueDate ?? "—");
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;color:#111">
      <h2 style="margin:0 0 8px">${escape(p.platform)} invoice ready</h2>
      <p style="margin:0 0 16px;color:#555">Auto-fetched by Rudrans Credentials Vault.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <tr><td style="padding:6px 0;color:#555">Organisation</td><td>${escape(p.orgName)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Platform</td><td>${escape(p.platform)}</td></tr>
        ${p.invoiceNumber ? `<tr><td style="padding:6px 0;color:#555">Invoice #</td><td>${escape(p.invoiceNumber)}</td></tr>` : ""}
        <tr><td style="padding:6px 0;color:#555">Period</td><td>${escape(period)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Amount</td><td>${escape(amountStr)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Status</td><td>${escape(p.status)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Source</td><td>${escape(p.source)}</td></tr>
      </table>
      ${p.pdfLink ? `<p style="margin:20px 0"><a href="${escape(p.pdfLink)}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Download invoice PDF</a></p>` : `<p style="margin:20px 0;color:#a00">No PDF available — fetch via the platform admin if needed.</p>`}
      ${p.loginUrl ? `<p style="margin:8px 0;font-size:12px;color:#888">Platform: <a href="${escape(p.loginUrl)}">${escape(p.loginUrl)}</a></p>` : ""}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="font-size:12px;color:#888;margin:0">You're receiving this because your address is listed under <em>Accounts recipients</em> in Rudrans. Update the list in Settings → Notifications.</p>
    </div>
  `;
}

function escape(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  } as Record<string, string>)[c]);
}

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
