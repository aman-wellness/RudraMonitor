// POST /functions/v1/invoice-digest-check
// Headers: Authorization: Bearer <SERVICE_ROLE_KEY>  (cron only)
//
// Runs every 15 minutes (see invoice_digest_tick in migration 0091).
// For each org with `invoice_digest_enabled = true`, computes the
// current local time in `invoice_digest_timezone`. If that time is
// within ±15 minutes of `invoice_digest_time` AND we haven't already
// sent today, sends the daily digest email listing every invoice
// received in the last 24 hours.
//
// Idempotent — `invoice_digest_last_sent_at` is updated AFTER a
// successful send, and the comparison uses the local date to detect
// "same day".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface DigestOrg {
  id: string;
  name: string | null;
  invoice_digest_enabled: boolean;
  invoice_digest_time: string;                // "HH:MM:SS"
  invoice_digest_timezone: string;
  invoice_digest_recipient_emails: string[];
  invoice_digest_last_sent_at: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ") || auth.slice(7).trim() !== SERVICE_ROLE_KEY) {
    return json({ error: "service role required" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name, invoice_digest_enabled, invoice_digest_time, invoice_digest_timezone, invoice_digest_recipient_emails, invoice_digest_last_sent_at")
    .eq("invoice_digest_enabled", true);

  if (!orgs?.length) return json({ ok: true, checked: 0, sent: 0 }, 200);

  let sent = 0;
  const skipped: Array<{ org: string; reason: string }> = [];
  const errors: Array<{ org: string; error: string }> = [];

  for (const org of orgs as DigestOrg[]) {
    const tz = org.invoice_digest_timezone || "Asia/Kolkata";
    const target = org.invoice_digest_time || "09:00:00";

    let nowLocal: { hh: number; mm: number; ymd: string };
    try { nowLocal = currentLocal(tz); }
    catch (e) {
      skipped.push({ org: org.id, reason: `bad tz: ${(e as Error).message}` });
      continue;
    }
    const [thh, tmm] = target.split(":").map((x) => parseInt(x, 10));
    const minutesNow = nowLocal.hh * 60 + nowLocal.mm;
    const minutesTarget = (thh ?? 9) * 60 + (tmm ?? 0);
    const delta = Math.abs(minutesNow - minutesTarget);

    // Within ±15 min of configured time?
    if (delta > 15 && delta < (24 * 60 - 15)) {
      skipped.push({ org: org.id, reason: `not target time (now ${nowLocal.hh}:${nowLocal.mm}, want ${target})` });
      continue;
    }

    // Already sent today (in org's local date)?
    if (org.invoice_digest_last_sent_at) {
      const lastLocal = localDate(new Date(org.invoice_digest_last_sent_at), tz);
      if (lastLocal === nowLocal.ymd) {
        skipped.push({ org: org.id, reason: "already sent today" });
        continue;
      }
    }

    // Recipients fallback to org-wide accounts list if digest list is empty.
    let recipients = org.invoice_digest_recipient_emails ?? [];
    if (recipients.length === 0) {
      const { data: o2 } = await admin.from("organizations")
        .select("accounts_recipient_emails").eq("id", org.id).maybeSingle();
      recipients = (o2?.accounts_recipient_emails as string[] | null) ?? [];
    }
    if (recipients.length === 0) {
      skipped.push({ org: org.id, reason: "no recipients" });
      continue;
    }

    // Pull last 24h of invoices for this org.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: invs } = await admin
      .from("v_credential_invoices")
      .select("id, platform_name, invoice_number, issue_date, amount, currency, status, source, pdf_url, attachment_path")
      .eq("org_id", org.id)
      .gt("created_at", since)
      .order("created_at", { ascending: false });

    try {
      await sendDigest(admin, org, recipients, invs ?? []);
      await admin.from("organizations")
        .update({ invoice_digest_last_sent_at: new Date().toISOString() })
        .eq("id", org.id);
      sent++;
    } catch (e) {
      errors.push({ org: org.id, error: (e as Error).message });
    }
  }

  return json({ ok: true, checked: orgs.length, sent, skipped, errors }, 200);
});

async function sendDigest(
  admin: ReturnType<typeof createClient>,
  org: DigestOrg,
  recipients: string[],
  invs: Array<{
    id: string;
    platform_name: string | null;
    invoice_number: string | null;
    issue_date: string | null;
    amount: number | null;
    currency: string | null;
    status: string;
    source: string;
    pdf_url: string | null;
    attachment_path: string | null;
  }>,
): Promise<void> {
  // Build short signed URLs for any bucket-stored PDFs (1-day validity).
  const links: Record<string, string> = {};
  for (const inv of invs) {
    if (inv.pdf_url) { links[inv.id] = inv.pdf_url; continue; }
    if (inv.attachment_path) {
      const { data: signed } = await admin.storage.from("credential-invoices")
        .createSignedUrl(inv.attachment_path, 60 * 60 * 24);
      if (signed?.signedUrl) links[inv.id] = signed.signedUrl;
    }
  }

  const rows = invs.map((i) => {
    const url = links[i.id];
    const amount = i.amount != null ? `${i.currency ?? ""} ${Number(i.amount).toLocaleString()}` : "—";
    const link = url ? `<a href="${esc(url)}">PDF</a>` : "—";
    return `
      <tr>
        <td style="padding:8px 12px 8px 0">${esc(i.platform_name ?? "Unassigned")}</td>
        <td style="padding:8px 12px 8px 0;font-family:monospace;color:#555">${esc(i.invoice_number ?? "")}</td>
        <td style="padding:8px 12px 8px 0;color:#555">${esc(i.issue_date ?? "")}</td>
        <td style="padding:8px 12px 8px 0;text-align:right">${esc(amount)}</td>
        <td style="padding:8px 12px 8px 0;color:#555">${esc(i.status)}</td>
        <td style="padding:8px 0">${link}</td>
      </tr>`;
  }).join("");

  const orgLabel = esc(org.name ?? "");
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:640px;color:#111">
      <h2 style="margin:0 0 6px">Daily invoice digest</h2>
      <p style="margin:0 0 16px;color:#555">${orgLabel} · last 24 hours · ${invs.length} invoice${invs.length === 1 ? "" : "s"}</p>
      ${invs.length === 0
        ? `<p style="color:#888;font-style:italic">No invoices received in the last 24 hours.</p>`
        : `<table style="border-collapse:collapse;font-size:13px;width:100%">
             <thead><tr style="border-bottom:1px solid #ddd;text-align:left;color:#888">
               <th style="padding:6px 12px 6px 0">Platform</th>
               <th style="padding:6px 12px 6px 0">Invoice #</th>
               <th style="padding:6px 12px 6px 0">Issued</th>
               <th style="padding:6px 12px 6px 0;text-align:right">Amount</th>
               <th style="padding:6px 12px 6px 0">Status</th>
               <th style="padding:6px 0">File</th>
             </tr></thead>
             <tbody>${rows}</tbody>
           </table>`}
      <p style="margin-top:24px;font-size:11px;color:#888">Sent by Rudrans Auto-Invoice. Change schedule or recipients in Auto-Invoice Center → Daily digest.</p>
    </div>`;

  const { sendGraphEmail } = await import("../_shared/graph-email.ts");
  const r = await sendGraphEmail({
    to: recipients,
    subject: `[Rudrans] Daily invoice digest · ${invs.length} new`,
    html,
    orgId: org.id,
  });
  if (!r.ok) throw new Error(r.error ?? "send failed");

  // Activity-feed event.
  const { logEvent } = await import("../_shared/event-log.ts");
  await logEvent({
    orgId: org.id,
    kind: "forwarded", actor: "cron", channel: "digest",
    message: `Daily digest sent: ${invs.length} invoice${invs.length === 1 ? "" : "s"} → ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`,
    detail: { recipients, count: invs.length },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────
function currentLocal(tz: string): { hh: number; mm: number; ymd: string } {
  // Use Intl.DateTimeFormat — Deno supports IANA tz names.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    hh: parseInt(get("hour"), 10),
    mm: parseInt(get("minute"), 10),
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
  };
}
function localDate(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  } as Record<string, string>)[c]);
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
