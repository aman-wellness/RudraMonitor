// POST /functions/v1/invoice-otp-request
// Headers: Authorization: Bearer <SERVICE_ROLE_KEY>  (worker only)
// Body:    { job_id: string, prompt: string }
//
// Worker calls this when login hits an OTP/MFA screen. We:
//   1. Generate a random magic token, store its sha-256 hash.
//   2. Insert otp_requests row with 5-min expiry.
//   3. Fan out to the credential's configured channels. v1 supports
//      `magic_link` + `dashboard` + `email_relay`. Phase 3 adds Teams /
//      Slack / Google Chat / WhatsApp via _shared/otp-channels.ts.
//   4. Return { request_id, poll_url, expires_at } — worker polls the
//      poll_url every 2 s until status='fulfilled' or status='expired'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { randomTokenBase64Url, sha256Hex } from "../_shared/hmac.ts";
import { getIntegration } from "../_shared/integrations.ts";
import { logEvent } from "../_shared/event-log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TTL_SECONDS = 300;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ") || auth.slice(7).trim() !== SERVICE_ROLE_KEY) {
    return json({ error: "service role required" }, 401);
  }

  let body: { job_id?: string; prompt?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const jobId = (body.job_id ?? "").trim();
  const prompt = (body.prompt ?? "").trim() || "Enter OTP / authenticator code";
  if (!jobId) return json({ error: "job_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: job } = await admin
    .from("invoice_fetch_jobs")
    .select("id, org_id, credential_id, status")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return json({ error: "job not found" }, 404);
  if (job.status !== "running") {
    return json({ error: `job is ${job.status}, not running` }, 409);
  }

  const { data: cred } = await admin
    .from("credentials")
    .select("platform_name, otp_primary_channel, otp_fallback_channels, otp_admin_user_ids")
    .eq("id", job.credential_id)
    .maybeSingle();
  if (!cred) return json({ error: "credential not found" }, 404);

  // Generate magic token + hash.
  const rawToken = randomTokenBase64Url(32);
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();

  // Resolve channels: primary + fallbacks, dedupe.
  const channels = [cred.otp_primary_channel, ...(cred.otp_fallback_channels ?? [])]
    .filter((x): x is string => !!x);
  const uniqueChannels = Array.from(new Set(channels));

  // Insert the request.
  const { data: inserted, error: insErr } = await admin
    .from("otp_requests")
    .insert({
      org_id: job.org_id,
      credential_id: job.credential_id,
      job_id: job.id,
      prompt: `${cred.platform_name}: ${prompt}`,
      magic_token_hash: tokenHash,
      channels_sent: uniqueChannels,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (insErr || !inserted) return json({ error: `insert: ${insErr?.message}` }, 500);

  // Flag job as awaiting OTP so the UI can show "needs OTP" pill.
  await admin.from("invoice_fetch_jobs").update({ status: "needs_otp" }).eq("id", jobId);

  const baseUrl = (await getIntegration("MAGIC_LINK_BASE_URL").catch(() => ""))
    || "https://ems.wellnessextract.com";
  const magicUrl = `${baseUrl}/otp/${inserted.id}?token=${encodeURIComponent(rawToken)}`;

  // Phase 2 channels: magic_link (email to admins), dashboard (realtime),
  // email_relay. Teams/Slack/etc dispatched in Phase 3 from this same point.
  const channelOutcomes: Record<string, string> = {};
  for (const ch of uniqueChannels) {
    if (ch === "totp") {
      // TOTP doesn't need a request — worker generates locally. If we got
      // here, it means TOTP wasn't available so this channel is a no-op.
      channelOutcomes[ch] = "skipped";
      continue;
    }
    if (ch === "dashboard") {
      // Realtime insert above already triggers the dashboard banner.
      channelOutcomes[ch] = "broadcast";
      continue;
    }
    if (ch === "magic_link" || ch === "email_relay") {
      const outcome = await sendMagicLinkEmail(admin, {
        orgId: job.org_id,
        adminIds: cred.otp_admin_user_ids ?? [],
        platform: cred.platform_name,
        prompt,
        magicUrl,
        expiresMin: Math.floor(TTL_SECONDS / 60),
      });
      channelOutcomes[ch] = outcome;
      continue;
    }
    if (ch === "teams" || ch === "slack" || ch === "google_chat" || ch === "whatsapp") {
      const { dispatchChannel } = await import("../_shared/otp-channels.ts");
      const r = await dispatchChannel(ch, {
        orgId: job.org_id,
        platform: cred.platform_name,
        prompt,
        magicUrl,
        expiresMin: Math.floor(TTL_SECONDS / 60),
      });
      channelOutcomes[ch] = r.ok ? `sent:${r.sent?.length ?? 1}` : `failed:${r.error ?? "?"}`;
      continue;
    }
    // sms_manual — out of scope; admin gets push via dashboard banner instead.
    channelOutcomes[ch] = "unsupported";
  }

  await logEvent({
    orgId: job.org_id, credentialId: job.credential_id, jobId: job.id,
    kind: "needs_otp", actor: "worker",
    message: `OTP requested via ${uniqueChannels.join(", ")}`,
    detail: { request_id: inserted.id, channels: channelOutcomes },
  });

  return json({
    request_id: inserted.id,
    poll_url: `${SUPABASE_URL}/functions/v1/invoice-otp-status?id=${inserted.id}`,
    expires_at: expiresAt,
    channels: channelOutcomes,
  }, 200);
});

async function sendMagicLinkEmail(
  admin: ReturnType<typeof createClient>,
  p: { orgId: string; adminIds: string[]; platform: string; prompt: string; magicUrl: string; expiresMin: number },
): Promise<string> {
  // Resolve admin emails. If no specific admins, fall back to the org owner.
  let emails: string[] = [];
  if (p.adminIds.length) {
    const { data } = await admin.from("v_org_users")
      .select("work_email")
      .in("row_id", p.adminIds);
    emails = (data ?? []).map((r: any) => r.work_email).filter(Boolean);
  }
  if (!emails.length) {
    const { data: org } = await admin.from("organizations")
      .select("owner_user_id").eq("id", p.orgId).maybeSingle();
    if (org?.owner_user_id) {
      const { data: u } = await admin.from("v_org_users")
        .select("work_email").eq("row_id", org.owner_user_id).maybeSingle();
      if (u?.work_email) emails = [u.work_email];
    }
  }
  if (!emails.length) return "no_recipients";

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;color:#111">
      <h2 style="margin:0 0 8px">OTP needed for ${escape(p.platform)}</h2>
      <p style="color:#444;margin:0 0 16px">${escape(p.prompt)}</p>
      <p style="margin:18px 0"><a href="${escape(p.magicUrl)}" style="background:#111;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Enter OTP</a></p>
      <p style="font-size:12px;color:#888;margin:8px 0">This link expires in ${p.expiresMin} minutes. Single-use.</p>
      <p style="font-size:11px;color:#aaa">Sent by Rudrans Auto-Invoice. You're listed as an OTP admin for ${escape(p.platform)} in your Credentials Vault.</p>
    </div>
  `;
  const { sendGraphEmail } = await import("../_shared/graph-email.ts");
  const r = await sendGraphEmail({
    to: emails,
    subject: `[Rudrans] OTP needed for ${p.platform}`,
    html,
    orgId: p.orgId,
  });
  return r.ok ? `sent:${emails.length}` : `send_failed:${r.error}`;
}

function escape(s: string | null | undefined): string {
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
