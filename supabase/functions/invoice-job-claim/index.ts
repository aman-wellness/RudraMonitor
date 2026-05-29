// POST /functions/v1/invoice-job-claim
// Headers: Authorization: Bearer <SERVICE_ROLE_KEY> (worker only)
// Body:    { worker_id: string, max?: number }
//
// Atomically locks up to `max` queued scrape-tier jobs for this worker
// (default 1). The EC2 Playwright worker polls this every ~30 s. Returns
// the full job payload + decrypted credentials needed to drive the
// browser:
//
//   {
//     jobs: [{
//       job_id, org_id, credential_id, platform_name, login_url,
//       username, password, totp_secret, session_cookies,
//       otp_primary_channel, otp_fallback_channels, otp_admin_user_ids,
//       billing_period_start, billing_period_end
//     }]
//   }
//
// Credentials are decrypted only here, in the worker request path. They
// never touch the browser or Postgres logs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { decrypt } from "../_shared/crypto.ts";
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

  let body: { worker_id?: string; max?: number };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const workerId = (body.worker_id ?? "").trim() || "ec2-worker";
  const max = Math.min(Math.max(body.max ?? 1, 1), 5);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Pick candidates: scrape-tier queued jobs, oldest first. Also re-claim
  // stale `running` jobs whose lock is older than 1 h (worker died mid-job).
  const staleCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data: candidates } = await admin
    .from("invoice_fetch_jobs")
    .select("id, org_id, credential_id, billing_period_start, billing_period_end, tier, status, locked_at")
    .or(`and(status.eq.queued,tier.eq.scrape),and(status.eq.running,locked_at.lt.${staleCutoff})`)
    .order("created_at", { ascending: true })
    .limit(max * 3);

  const out: Array<Record<string, unknown>> = [];
  for (const c of candidates ?? []) {
    if (out.length >= max) break;

    // Atomic claim — only flip if it's still in the state we saw.
    const { data: claimed } = await admin
      .from("invoice_fetch_jobs")
      .update({
        status: "running",
        locked_by: workerId,
        locked_at: new Date().toISOString(),
        attempts: 0,           // attempts is incremented on the worker-complete path
      })
      .eq("id", c.id)
      .eq("status", c.status)  // optimistic-lock guard
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    // Fetch the credential + decrypt secrets.
    const { data: cred } = await admin
      .from("credentials")
      .select(
        "id, platform_name, login_url, username, password_enc, totp_secret_enc, session_cookies_enc, otp_primary_channel, otp_fallback_channels, otp_admin_user_ids",
      )
      .eq("id", c.credential_id)
      .maybeSingle();
    if (!cred) {
      await admin.from("invoice_fetch_jobs").update({
        status: "failed",
        last_error: "credential row vanished",
        completed_at: new Date().toISOString(),
      }).eq("id", c.id);
      continue;
    }

    const [password, totp, cookies] = await Promise.all([
      cred.password_enc ? decrypt(cred.password_enc, "CRED_VAULT_ENC_KEY").catch(() => "") : Promise.resolve(""),
      cred.totp_secret_enc ? decrypt(cred.totp_secret_enc, "CRED_VAULT_ENC_KEY").catch(() => "") : Promise.resolve(""),
      cred.session_cookies_enc ? decrypt(cred.session_cookies_enc, "CRED_VAULT_ENC_KEY").catch(() => "") : Promise.resolve(""),
    ]);

    await logEvent({
      orgId: c.org_id, credentialId: cred.id, jobId: c.id,
      kind: "tier_scrape_started", actor: `worker:${workerId}`,
      message: `Browser-agent started: ${cred.platform_name}`,
      detail: { worker_id: workerId },
    });

    out.push({
      job_id: c.id,
      org_id: c.org_id,
      credential_id: cred.id,
      platform_name: cred.platform_name,
      login_url: cred.login_url,
      username: cred.username,
      password,
      totp_secret: totp,
      session_cookies: cookies,
      otp_primary_channel: cred.otp_primary_channel,
      otp_fallback_channels: cred.otp_fallback_channels,
      otp_admin_user_ids: cred.otp_admin_user_ids,
      billing_period_start: c.billing_period_start,
      billing_period_end: c.billing_period_end,
    });
  }

  return json({ jobs: out }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
