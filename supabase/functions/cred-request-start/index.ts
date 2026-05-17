// POST /functions/v1/cred-request-start            (PUBLIC — no auth)
// Body: { work_email: string }
//
// Step 1 of the public credential-request flow. We look up an active employee
// by work_email. If found, we mint a 30-min HMAC-signed form-session token
// and email a magic link to that work_email. If not found, we return the same
// "if your email matches" response (no enumeration).

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { signToken } from "../_shared/hmac-token.ts";
import { sendGraphEmail } from "../_shared/graph-email.ts";
import { getIntegration } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { work_email?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const email = (body.work_email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return json({ error: "work_email required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: emp } = await admin
    .from("employees")
    .select("id, org_id, full_name, work_email, status")
    .ilike("work_email", email)
    .eq("status", "active")
    .maybeSingle();

  // Always respond OK to avoid email-enumeration. Only actually send a link
  // if we found a match.
  if (emp) {
    const expSec = Math.floor(Date.now() / 1000) + 30 * 60;
    const token = await signToken(
      { kind: "cred_form", emp: emp.id, org: emp.org_id, exp: expSec },
      "CRED_REQUEST_SIGNING_KEY",
    );
    const appUrl = (await getIntegration("APP_PUBLIC_URL")) || (req.headers.get("origin") ?? "");
    const link = `${appUrl.replace(/\/+$/, "")}/r/credentials-request?t=${encodeURIComponent(token)}`;
    await sendGraphEmail({
      orgId: emp.org_id as string,
      to: emp.work_email!,
      subject: "Continue your credentials request",
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937">
        <h2 style="color:#0ea5e9;margin:0 0 12px">Continue your request</h2>
        <p>Hi ${escape(emp.full_name)},</p>
        <p>Click the button below within the next 30 minutes to pick the software you need. The link is single-session and will be tied to your account.</p>
        <p style="margin:20px 0"><a href="${escape(link)}" style="background:#0ea5e9;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Open request form</a></p>
        <p style="font-size:12px;color:#6b7280">If you didn't start this, you can safely ignore this email.</p>
      </body></html>`,
    });
  }

  return json({ ok: true, message: "If your work email matches an active employee, you'll receive a link within a minute." }, 200);
});

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
