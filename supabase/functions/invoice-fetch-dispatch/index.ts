// POST /functions/v1/invoice-fetch-dispatch
// Called by the daily pg_cron tick (or manually for testing). Walks the
// invoice_fetch_jobs queue and routes each queued job to its tier:
//
//   • tier=api    → call invoice-sync internally and mark success/failed
//   • tier=email  → mark `running` and wait for invoice-inbound (no work
//                   here — the webhook delivers the PDF when it arrives)
//   • tier=scrape → leave queued for the EC2 browser worker (Phase 2);
//                   it polls invoice-job-claim on its own
//
// Idempotent: only picks `queued` rows, atomically flips to `running` with
// a 60-min lease so concurrent ticks don't double-process.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { logEvent } from "../_shared/event-log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Auth: only accept service-role JWT (cron calls with it). Reject everything else.
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ error: "unauthorized" }, 401);
  if (auth.slice(7).trim() !== SERVICE_ROLE_KEY) {
    return json({ error: "service role required" }, 403);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Dispatcher only handles tiers it can synchronously execute (api / email).
  // Scrape-tier jobs are left for the EC2 worker to claim via its own poll
  // loop — otherwise the dispatcher just churns "Started/Requeued" events
  // every 5 minutes without doing useful work.
  const { data: queued, error: qErr } = await admin
    .from("invoice_fetch_jobs")
    .select("id, org_id, credential_id, billing_period_start, billing_period_end, tier, attempts")
    .eq("status", "queued")
    .in("tier", ["api", "email"])
    .order("created_at", { ascending: true })
    .limit(50);
  if (qErr) return json({ error: qErr.message }, 500);
  if (!queued?.length) return json({ ok: true, processed: 0 }, 200);

  const results: Array<{ id: string; outcome: string; error?: string }> = [];

  for (const job of queued) {
    // Atomically claim.
    const { data: claimed, error: cErr } = await admin
      .from("invoice_fetch_jobs")
      .update({
        status: "running",
        locked_by: "invoice-fetch-dispatch",
        locked_at: new Date().toISOString(),
        attempts: (job.attempts ?? 0) + 1,
      })
      .eq("id", job.id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (cErr || !claimed) {
      results.push({ id: job.id, outcome: "skipped" });
      continue;
    }

    await logEvent({
      orgId: job.org_id, credentialId: job.credential_id, jobId: job.id,
      kind: "job_started", actor: "dispatcher",
      message: `Started ${job.tier} fetch`,
      detail: { tier: job.tier },
    });

    if (job.tier === "api") {
      const r = await runApiTier(admin, job);
      await logEvent({
        orgId: job.org_id, credentialId: job.credential_id, jobId: job.id,
        kind: r.ok ? "tier_api_pulled" : "job_failed", actor: "dispatcher",
        message: r.ok ? "API tier pulled invoice" : `API tier failed: ${r.error}`,
        detail: { error: r.error },
      });
      results.push({ id: job.id, outcome: r.ok ? "api_success" : "api_failed", error: r.error });
    } else if (job.tier === "email") {
      // No-op for now; invoice-inbound writes invoice + closes job when the
      // PDF arrives. We just keep status=running with an updated heartbeat.
      results.push({ id: job.id, outcome: "email_waiting" });
    } else {
      // scrape: should never reach here due to the .in() filter above.
      // Defensive — revert the claim so the worker can pick it up.
      await admin.from("invoice_fetch_jobs").update({
        status: "queued",
        locked_by: null,
        locked_at: null,
      }).eq("id", job.id);
      results.push({ id: job.id, outcome: "scrape_left_for_worker" });
    }
  }

  return json({ ok: true, processed: queued.length, results }, 200);
});

// ── API tier: invoke invoice-sync edge fn ────────────────────────────────
async function runApiTier(
  admin: ReturnType<typeof createClient>,
  job: { id: string; org_id: string; credential_id: string; billing_period_start: string; billing_period_end: string },
): Promise<{ ok: boolean; error?: string }> {
  const url = `${SUPABASE_URL}/functions/v1/invoice-sync`;
  let body: { ok?: boolean; error?: string; matched_invoice_id?: string };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        credential_id: job.credential_id,
        period_start: job.billing_period_start,
        period_end: job.billing_period_end,
      }),
    });
    body = await r.json();
    if (!r.ok || body.error) {
      await admin.from("invoice_fetch_jobs").update({
        status: "failed",
        last_error: body.error ?? `http ${r.status}`,
        completed_at: new Date().toISOString(),
      }).eq("id", job.id);
      return { ok: false, error: body.error ?? `http ${r.status}` };
    }
  } catch (e) {
    const msg = (e as Error).message;
    await admin.from("invoice_fetch_jobs").update({
      status: "failed",
      last_error: msg,
      completed_at: new Date().toISOString(),
    }).eq("id", job.id);
    return { ok: false, error: msg };
  }

  await admin.from("invoice_fetch_jobs").update({
    status: "success",
    result_invoice_id: body.matched_invoice_id ?? null,
    completed_at: new Date().toISOString(),
  }).eq("id", job.id);
  await admin.from("credentials").update({
    last_fetch_attempt_at: new Date().toISOString(),
  }).eq("id", job.credential_id);

  return { ok: true };
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
