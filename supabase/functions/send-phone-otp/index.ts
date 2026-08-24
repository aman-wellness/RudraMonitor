// POST /functions/v1/send-phone-otp
// PUBLIC. Body: { email: "user@example.com" }
//
// Free OTP via Microsoft Graph (the same M365 mailbox we already use for auth
// emails). Generates a 6-digit code, stores its SHA-256 hash with a 5-minute
// TTL, then emails the plaintext code to the user. No third-party SMS cost.
//
// Despite the function name, the OTP target is the email — the signup flow
// collects email first, and email is free to deliver.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { sendGraphEmail } from "../_shared/graph-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { email?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Rate-limit: max 4 OTP sends per email per 10 minutes.
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("otp_codes")
    .select("id", { count: "exact", head: true })
    .ilike("target", email)
    .gte("created_at", since);
  if ((count ?? 0) >= 4) {
    return json({ error: "Too many OTP requests. Wait a few minutes and try again." }, 429);
  }

  // Generate a 6-digit code (000000-999999, zero-padded) from a CSPRNG.
  // SECURITY REVIEW M2: Math.random() is predictable; use crypto with
  // rejection sampling so all 10^6 codes are equally likely.
  const otpBuf = new Uint32Array(1);
  const otpLimit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  do { crypto.getRandomValues(otpBuf); } while (otpBuf[0] >= otpLimit);
  const code = String(otpBuf[0] % 1_000_000).padStart(6, "0");
  const codeHash = await sha256Hex(code);

  await admin.from("otp_codes").insert({
    target: email,
    code_hash: codeHash,
  });

  const html = /* html */`
<!DOCTYPE html>
<html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,sans-serif;color:#1a1a1a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
        <tr><td style="padding:28px 32px 0;font-weight:700;font-size:18px;color:#0f172a;">Rudrans</td></tr>
        <tr><td style="padding:20px 32px 0;">
          <h1 style="font-size:20px;margin:0 0 12px;color:#0f172a;">Your verification code</h1>
          <p style="font-size:14px;line-height:1.5;color:#475569;margin:0 0 20px;">
            Use this code to verify your email and continue signing up for Rudrans. The code expires in 5 minutes.
          </p>
          <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#0f172a;background:#eef2ff;padding:18px;border-radius:10px;text-align:center;font-family:monospace;">
            ${code}
          </div>
          <p style="font-size:12px;color:#94a3b8;margin:24px 0 0;line-height:1.5;">
            Didn't request this? You can safely ignore this email — no account changes will be made.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">
          Need help? <a href="mailto:itsupport@wellnessextract.com" style="color:#6366f1;text-decoration:none;">itsupport@wellnessextract.com</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const result = await sendGraphEmail({
    to: email,
    subject: `${code} — your Rudrans verification code`,
    html,
  });
  if (!result.ok) return json({ error: result.error ?? "email send failed" }, 500);

  return json({ ok: true, sent_to: email });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
