// OTP resolution. Tries TOTP locally first (zero round-trip). Falls back to
// the edge-fn relay, which fans out to magic-link / dashboard / Teams / etc.
// (the channel set is per-credential, decided in invoice-otp-request).

import { authenticator } from "otplib";
import { requestOtp, pollOtp } from "./supabase.js";

export async function resolveOtp(opts: {
  jobId: string;
  prompt: string;
  totpSecret: string;
  primaryChannel: string;
  timeoutSec?: number;
}): Promise<string> {
  // Path 1: TOTP — instant.
  if (opts.totpSecret && (opts.primaryChannel === "totp" || /authenticator|google authenticator|totp|6-digit code/i.test(opts.prompt))) {
    try {
      const code = authenticator.generate(opts.totpSecret.replace(/\s+/g, ""));
      if (code && /^\d{6}$/.test(code)) return code;
    } catch (e) {
      console.warn("totp generate failed, falling back to relay:", (e as Error).message);
    }
  }

  // Path 2: edge-fn relay.
  const { request_id, expires_at } = await requestOtp(opts.jobId, opts.prompt);
  const deadline = new Date(expires_at).getTime();
  const cap = opts.timeoutSec ? Date.now() + opts.timeoutSec * 1000 : Infinity;

  while (Date.now() < deadline && Date.now() < cap) {
    await sleep(2000);
    const r = await pollOtp(request_id);
    if (r.status === "fulfilled" && r.code) return r.code;
    if (r.status === "expired" || r.status === "cancelled") {
      throw new Error(`otp ${r.status}`);
    }
  }
  throw new Error("otp timeout");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
