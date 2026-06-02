// POST /functions/v1/auto-invoice-digest
// Headers: Authorization: Bearer <SERVICE_ROLE_KEY>   (cron only)
//
// Two responsibilities, run together so we only pay one DB walk:
//
//   1. Silent-failure detection — for every org, find credentials with
//      auto_fetch_enabled=true whose latest credential_invoices.issue_date
//      is older than 60 days (or who have never had one but billing
//      started > 35 days ago). Email the org owner so they know to
//      reconnect / check.
//
//   2. Weekly digest (Monday only) — counts of invoices fetched in the
//      last 7 days broken down by tier, channels used, and any open
//      `failed` / `needs_otp_timeout` jobs.
//
// Cron schedules this daily at 07:00 UTC (set in migration 0088 below if
// you want it auto-enabled; otherwise call manually).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logEvent } from "../_shared/event-log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  const isMonday = new Date().getUTCDay() === 1;
  const out: Record<string, unknown> = { silent: 0, digests_sent: 0 };

  // ── Silent-failure detection ─────────────────────────────────────────
  // We use a single big query: every active auto-fetch credential whose
  // most-recent invoice (if any) is > 60 days old, OR who has no invoice
  // at all AND started > 35 days ago.
  const cutoff60 = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const cutoff35 = new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const { data: creds } = await admin
    .from("credentials")
    .select("id, org_id, platform_name, subscription_starts_at")
    .eq("active", true)
    .eq("auto_fetch_enabled", true);

  const stale: Array<{ orgId: string; credId: string; platform: string; lastIssue: string | null }> = [];
  for (const c of creds ?? []) {
    const { data: latest } = await admin
      .from("credential_invoices")
      .select("issue_date")
      .eq("credential_id", c.id)
      .order("issue_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const last = (latest?.issue_date as string | null) ?? null;
    if (last) {
      if (last < cutoff60) stale.push({ orgId: c.org_id, credId: c.id, platform: c.platform_name, lastIssue: last });
    } else if (c.subscription_starts_at && c.subscription_starts_at < cutoff35) {
      stale.push({ orgId: c.org_id, credId: c.id, platform: c.platform_name, lastIssue: null });
    }
  }

  // Group + alert at most once per (org, credential) per 14 days.
  const alertCutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const byOrg = new Map<string, typeof stale>();
  for (const s of stale) {
    const { data: prior } = await admin
      .from("invoice_fetch_events")
      .select("id")
      .eq("credential_id", s.credId)
      .eq("kind", "silent_failure_alert")
      .gt("created_at", alertCutoff)
      .limit(1);
    if (prior?.length) continue;
    const list = byOrg.get(s.orgId) ?? [];
    list.push(s);
    byOrg.set(s.orgId, list);
  }

  for (const [orgId, list] of byOrg) {
    await sendSilentFailureEmail(admin, orgId, list);
    for (const item of list) {
      await logEvent({
        orgId, credentialId: item.credId,
        kind: "silent_failure_alert", actor: "cron",
        message: `Silent failure: no invoice for ${item.platform} since ${item.lastIssue ?? "ever"}`,
        detail: { last_issue: item.lastIssue },
      });
      out.silent = (out.silent as number) + 1;
    }
  }

  // ── Weekly digest (Mondays only) ──────────────────────────────────────
  if (isMonday) {
    const { data: orgs } = await admin.from("organizations").select("id, name, owner_user_id, accounts_recipient_emails");
    for (const org of orgs ?? []) {
      const stats = await weekStats(admin, org.id);
      if (stats.totalEvents === 0) continue;
      await sendDigestEmail(admin, org.id, org.name, stats);
      out.digests_sent = (out.digests_sent as number) + 1;
    }
  }

  return json({ ok: true, ...out }, 200);
});

interface WeekStats {
  totalEvents: number;
  successByTier: Record<string, number>;
  failures: number;
  openNeedsOtp: number;
  forwardedAmount: number;
}

async function weekStats(admin: ReturnType<typeof createClient>, orgId: string): Promise<WeekStats> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: events } = await admin
    .from("invoice_fetch_events")
    .select("kind, detail")
    .eq("org_id", orgId)
    .gt("created_at", weekAgo);
  const { data: openJobs } = await admin
    .from("invoice_fetch_jobs")
    .select("id, status")
    .eq("org_id", orgId)
    .in("status", ["needs_otp", "needs_otp_timeout", "needs_human"]);

  const successByTier: Record<string, number> = {};
  let failures = 0;
  let forwarded = 0;
  for (const e of events ?? []) {
    if (e.kind === "tier_api_pulled") successByTier.api = (successByTier.api ?? 0) + 1;
    if (e.kind === "tier_email_received") successByTier.email = (successByTier.email ?? 0) + 1;
    if (e.kind === "pdf_saved") successByTier.scrape = (successByTier.scrape ?? 0) + 1;
    if (e.kind === "job_failed") failures += 1;
    if (e.kind === "forwarded") {
      const amt = Number(((e.detail as { amount?: number })?.amount) ?? 0);
      if (!Number.isNaN(amt)) forwarded += amt;
    }
  }
  return {
    totalEvents: events?.length ?? 0,
    successByTier,
    failures,
    openNeedsOtp: openJobs?.length ?? 0,
    forwardedAmount: forwarded,
  };
}

async function sendSilentFailureEmail(
  admin: ReturnType<typeof createClient>,
  orgId: string,
  items: Array<{ credId: string; platform: string; lastIssue: string | null }>,
): Promise<void> {
  const { data: org } = await admin.from("organizations")
    .select("name, owner_user_id").eq("id", orgId).maybeSingle();
  if (!org?.owner_user_id) return;
  const { data: u } = await admin.from("v_org_users")
    .select("work_email").eq("row_id", org.owner_user_id).maybeSingle();
  const to = u?.work_email;
  if (!to) return;

  const rows = items.map((i) =>
    `<tr><td style="padding:6px 12px 6px 0">${esc(i.platform)}</td><td style="padding:6px 0">${esc(i.lastIssue ?? "never fetched")}</td></tr>`,
  ).join("");
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;color:#111">
      <h2 style="margin:0 0 8px">Auto-invoice fetcher needs your attention</h2>
      <p style="color:#555">These credentials haven't produced an invoice recently. Likely causes: a billing connector token expired, the platform's billing email changed, or 2FA blocks the scraper.</p>
      <table style="border-collapse:collapse;font-size:14px;margin-top:10px">
        <thead><tr><th style="text-align:left;color:#888">Platform</th><th style="text-align:left;color:#888">Last invoice</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:18px 0"><a href="${(Deno.env.get("APP_URL") ?? "https://ems.wellnessextract.com").replace(/\/+$/, "")}/employees/auto-invoice" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open Auto-Invoice center</a></p>
      <p style="font-size:11px;color:#aaa">We'll re-alert in 14 days if nothing changes. Disable auto-fetch per credential to silence.</p>
    </div>`;
  const { sendGraphEmail } = await import("../_shared/graph-email.ts");
  await sendGraphEmail({
    to,
    subject: `[Rudrans] ${items.length} credential${items.length === 1 ? "" : "s"} missed their invoice`,
    html,
    orgId,
  });
}

async function sendDigestEmail(
  admin: ReturnType<typeof createClient>,
  orgId: string,
  orgName: string | null,
  s: WeekStats,
): Promise<void> {
  const { data: org } = await admin.from("organizations")
    .select("owner_user_id, accounts_recipient_emails").eq("id", orgId).maybeSingle();
  if (!org) return;
  const recipients: string[] = [];
  if (Array.isArray(org.accounts_recipient_emails)) recipients.push(...org.accounts_recipient_emails);
  if (recipients.length === 0 && org.owner_user_id) {
    const { data: u } = await admin.from("v_org_users")
      .select("work_email").eq("row_id", org.owner_user_id).maybeSingle();
    if (u?.work_email) recipients.push(u.work_email);
  }
  if (!recipients.length) return;

  const totalSuccess = Object.values(s.successByTier).reduce((a, b) => a + b, 0);
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;color:#111">
      <h2 style="margin:0 0 8px">Auto-invoice weekly digest</h2>
      <p style="color:#555">${esc(orgName ?? "Your org")} · last 7 days</p>
      <table style="border-collapse:collapse;font-size:14px;margin-top:10px">
        <tr><td style="padding:6px 12px 6px 0;color:#888">Invoices fetched</td><td><b>${totalSuccess}</b> (api ${s.successByTier.api ?? 0} · email ${s.successByTier.email ?? 0} · scrape ${s.successByTier.scrape ?? 0})</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#888">Failures</td><td>${s.failures}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#888">Open OTP / human review</td><td>${s.openNeedsOtp}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#888">Forwarded amount</td><td>${s.forwardedAmount.toLocaleString()}</td></tr>
      </table>
      <p style="margin:18px 0"><a href="${(Deno.env.get("APP_URL") ?? "https://ems.wellnessextract.com").replace(/\/+$/, "")}/employees/auto-invoice" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open Auto-Invoice center</a></p>
    </div>`;
  const { sendGraphEmail } = await import("../_shared/graph-email.ts");
  await sendGraphEmail({
    to: recipients,
    subject: `[Rudrans] Auto-invoice digest · ${totalSuccess} fetched this week`,
    html,
    orgId,
  });
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
