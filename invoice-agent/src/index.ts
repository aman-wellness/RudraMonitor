// Main loop. Claim → drive → complete, forever.

import "dotenv/config";
import * as fs from "node:fs/promises";
import { claimJobs, completeJob, type ClaimedJob, type CompletePayload } from "./supabase.js";
import { openSession, execAction, dumpCookies, screenshot, snapshotDom } from "./browser.js";
import { nextAction, PASSWORD_PLACEHOLDER } from "./llm.js";
import { resolveOtp } from "./otp.js";

const WORKER_ID = process.env.WORKER_ID ?? "ec2-invoice-agent-01";
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL_SECONDS ?? 30) * 1000;
const MAX_STEPS = Number(process.env.MAX_STEPS_PER_JOB ?? 40);

async function main(): Promise<void> {
  console.log(`[${WORKER_ID}] starting; polling every ${POLL_INTERVAL / 1000}s`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const jobs = await claimJobs(WORKER_ID, 1);
      if (jobs.length === 0) {
        await sleep(POLL_INTERVAL);
        continue;
      }
      for (const job of jobs) {
        await runJob(job);
      }
    } catch (e) {
      console.error("loop error:", (e as Error).message);
      await sleep(POLL_INTERVAL);
    }
  }
}

async function runJob(job: ClaimedJob): Promise<void> {
  const tag = `[${job.job_id.slice(0, 8)} ${job.platform_name}]`;
  console.log(`${tag} starting`);
  if (!job.login_url) {
    await completeJob({ job_id: job.job_id, outcome: "failed", error: "no login_url on credential" });
    return;
  }

  const session = await openSession(job.session_cookies || undefined);
  let pdfPath: string | undefined;
  let invoiceFields: Record<string, unknown> = {};
  let lastResult = "(none)";
  let outcome: CompletePayload["outcome"] = "failed";
  let errorMsg: string | undefined = "max steps without download";

  try {
    await session.page.goto(job.login_url, { waitUntil: "domcontentloaded", timeout: 30000 });

    for (let step = 0; step < MAX_STEPS; step++) {
      const shot = await screenshot(session.page);
      const dom = await snapshotDom(session.page);
      const action = await nextAction({
        goal: `Download the latest invoice PDF for ${job.platform_name}. Billing period: ${job.billing_period_start} to ${job.billing_period_end}.`,
        url: session.page.url(),
        username: job.username,
        passwordHint: job.password ? "saved password available — use placeholder " + PASSWORD_PLACEHOLDER : "no password (OTP-only login)",
        screenshotB64: shot,
        domSnapshot: dom,
        lastActionResult: lastResult,
        step,
      });

      // Substitute the real password just before the `type` dispatch.
      if (action.type === "type" && action.value === PASSWORD_PLACEHOLDER) {
        action.value = job.password;
      }

      const result = await execAction(session, action);
      lastResult = result.note ?? (result.ok ? "ok" : "failed");

      if (result.needsOtp) {
        try {
          const code = await resolveOtp({
            jobId: job.job_id,
            prompt: result.needsOtp.prompt,
            totpSecret: job.totp_secret,
            primaryChannel: job.otp_primary_channel,
          });
          lastResult = `otp resolved (length ${code.length})`;
          // Hand the code back to the model — it knows which input to fill.
          // We stash it in lastResult so the next nextAction() call sees it.
          lastResult = `OTP resolved: ${code}`;
        } catch (e) {
          outcome = "needs_otp_timeout";
          errorMsg = (e as Error).message;
          break;
        }
        continue;
      }
      if (result.pdfPath) pdfPath = result.pdfPath;
      if (result.invoice) invoiceFields = { ...invoiceFields, ...result.invoice };
      if (result.terminal === "success") {
        outcome = pdfPath ? "success" : "failed";
        errorMsg = pdfPath ? undefined : "done_success without pdf";
        break;
      }
      if (result.terminal === "failed") {
        outcome = "failed";
        errorMsg = result.note;
        break;
      }
      if (result.terminal === "needs_human") {
        outcome = "needs_human";
        errorMsg = result.note;
        break;
      }
    }

    // Persist cookies regardless of outcome (post-login state may be useful).
    let cookieJson: string | undefined;
    try { cookieJson = await dumpCookies(session.ctx); } catch { /* ignore */ }

    const payload: CompletePayload = {
      job_id: job.job_id,
      outcome,
      error: errorMsg,
      session_cookies: cookieJson,
    };

    if (outcome === "success" && pdfPath) {
      const bytes = await fs.readFile(pdfPath);
      payload.invoice = {
        ...invoiceFields,
        pdf_base64: bytes.toString("base64"),
        pdf_filename: pdfPath.split("/").pop() || "invoice.pdf",
      };
    }

    await completeJob(payload);
    console.log(`${tag} ${outcome}${errorMsg ? `: ${errorMsg}` : ""}`);
  } catch (e) {
    console.error(`${tag} crashed:`, (e as Error).message);
    await completeJob({ job_id: job.job_id, outcome: "failed", error: (e as Error).message }).catch(() => null);
  } finally {
    await session.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
