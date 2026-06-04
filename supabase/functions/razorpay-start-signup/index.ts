// POST /functions/v1/razorpay-start-signup
// PUBLIC (no auth) — runs from the marketing-site signup form BEFORE the
// customer has any account. We DON'T create the auth user here. Instead:
//
//   1. Save the form fields into pending_signups (no auth user yet).
//   2. Create a Razorpay Customer + Subscription with:
//        - 14-day trial (start_at = now() + 14 days)
//        - ₹2 (or $0.50) verification addon — captured immediately on auth.
//   3. Return subscription_id so the browser can open Razorpay Checkout.
//
// Once the customer authenticates (pays the ₹2), the webhook
// (`razorpay-webhook` → `subscription.authenticated`) is what actually:
//   - creates the auth user via inviteUserByEmail (sends welcome+invite email)
//   - creates the org + 14-day trial license
//
// So the user only ever gets an email AFTER successful payment.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";
import { findAuthUserIdByEmail } from "../_shared/find-user.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const VERIFY_INR_PAISE = 200;   // ₹2.00
const VERIFY_USD_CENTS = 50;    // $0.50

type Body = {
  full_name?: string;
  email?: string;
  org_name?: string;
  plan_id?: string;
  plan_code?: string;
  phone?: string;
  country?: string;
  // Optional company details — captured upfront for invoicing + sales
  // follow-up. Stored on pending_signups, copied to organizations on
  // finalize. All trimmed + nulled-if-empty server-side.
  gst_number?: string;
  pan_number?: string;
  address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  // If caller is authenticated (OAuth signup completing), trust the JWT for
  // email + identity and skip the OTP gate — the OAuth provider already
  // verified the email. The user_id from the JWT gets stamped onto the
  // pending row so the webhook skips inviteUserByEmail.
  const adminAuth = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let authedUserId: string | null = null;
  let authedEmail:  string | null = null;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (token) {
    const { data: { user: jwtUser } } = await adminAuth.auth.getUser(token);
    if (jwtUser?.id && jwtUser.email) {
      authedUserId = jwtUser.id;
      authedEmail  = jwtUser.email.toLowerCase();
    }
  }

  const fullName = (body.full_name ?? "").trim();
  const email    = (authedEmail ?? body.email ?? "").trim().toLowerCase();
  const orgName  = (body.org_name ?? "").trim();
  const planRef  = (body.plan_id ?? body.plan_code ?? "").trim();
  const phone    = body.phone?.trim() || null;
  const country  = (body.country ?? "India").trim();
  const trimOrNull = (v: string | undefined) => {
    const t = (v ?? "").trim();
    return t.length > 0 ? t : null;
  };
  const gstNumber  = trimOrNull(body.gst_number);
  const panNumber  = trimOrNull(body.pan_number);
  const address    = trimOrNull(body.address);
  const city       = trimOrNull(body.city);
  const state      = trimOrNull(body.state);
  const postalCode = trimOrNull(body.postal_code);

  if (!fullName) return json({ error: "full_name required" }, 400);
  if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);
  if (!orgName)  return json({ error: "org_name required" }, 400);
  if (!planRef)  return json({ error: "plan_id or plan_code required" }, 400);

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(planRef);

  // Email must have been OTP-verified within the last 30 minutes — UNLESS the
  // caller is already authenticated (OAuth provider verified the email for us).
  if (!authedUserId) {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: cv } = await adminAuth
      .from("contact_verifications")
      .select("target")
      .ilike("target", email)
      .gte("verified_at", since)
      .maybeSingle();
    if (!cv) {
      return json({ error: "Email not verified — request and enter the OTP first" }, 400);
    }
  }

  const cfg = await getIntegrations(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]);
  const KEY_ID = cfg.RAZORPAY_KEY_ID;
  const KEY_SECRET = cfg.RAZORPAY_KEY_SECRET;
  if (!KEY_ID || !KEY_SECRET) {
    return json({ error: "Razorpay credentials not configured (Admin → Integrations)" }, 500);
  }
  const rzpAuth = "Basic " + btoa(`${KEY_ID}:${KEY_SECRET}`);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Don't accept signup if the user already owns an org (handles both
  //    OAuth-authenticated callers and email/OTP signups where the user was
  //    invited earlier).
  if (authedUserId) {
    const { data: org } = await admin
      .from("organizations").select("id").eq("owner_user_id", authedUserId).maybeSingle();
    if (org) return json({ error: "You already have an organization." }, 409);
  } else {
    const existingUserId = await findAuthUserIdByEmail(admin, email);
    if (existingUserId) {
      const { data: org } = await admin
        .from("organizations").select("id").eq("owner_user_id", existingUserId).maybeSingle();
      if (org) return json({ error: "An account with this email already exists. Sign in instead." }, 409);
    }
  }

  // 2. Look up the plan + currency choice. Caller may pass UUID (plan_id) or
  //    short code (plan_code, e.g. "starter-m") — resolve both.
  const planQuery = admin
    .from("plans")
    .select("id, name, billing_cycle, razorpay_plan_id, razorpay_plan_id_usd, price_inr, price_usd")
    .eq("is_active", true);
  const { data: plan, error: planErr } = await (isUuid
    ? planQuery.eq("id", planRef).maybeSingle()
    : planQuery.eq("code", planRef).maybeSingle());
  if (planErr || !plan) return json({ error: `plan not found for "${planRef}"` }, 400);
  const planId = plan.id;

  const isIndia = country.toLowerCase() === "india" || country.toLowerCase() === "in";
  const useUSD = !isIndia && !!plan.razorpay_plan_id_usd;
  const currency = useUSD ? "USD" : "INR";
  const razorpayPlanId = useUSD ? plan.razorpay_plan_id_usd : plan.razorpay_plan_id;
  const verifyAmt = useUSD ? VERIFY_USD_CENTS : VERIFY_INR_PAISE;
  if (!razorpayPlanId) {
    return json({
      error: useUSD
        ? `Plan "${plan.name}" has no USD Razorpay plan id configured.`
        : `Plan "${plan.name}" has no INR Razorpay plan id configured.`,
    }, 400);
  }

  // 3. Replace any abandoned pending row for this email, then insert fresh.
  await admin
    .from("pending_signups")
    .delete()
    .ilike("email", email)
    .neq("status", "completed");

  const { data: pendingRow, error: psErr } = await admin
    .from("pending_signups")
    .insert({
      email, full_name_pending: fullName,
      org_name: orgName, plan_id: planId, phone, country,
      user_id: authedUserId,
      gst_number: gstNumber, pan_number: panNumber,
      address, city, state, postal_code: postalCode,
    })
    .select("id")
    .single();
  if (psErr || !pendingRow) return json({ error: `pending row: ${psErr?.message ?? "unknown"}` }, 500);

  // 4. Create / reuse Razorpay Customer.
  const custResp = await fetch("https://api.razorpay.com/v1/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: rzpAuth },
    body: JSON.stringify({
      name: orgName, email, contact: phone ?? undefined,
      fail_existing: 0,
      notes: { pending_signup_id: pendingRow.id, source: "wellness-extract-signup" },
    }),
  });
  if (!custResp.ok) {
    const t = await custResp.text();
    return json({ error: `razorpay customer: ${t}` }, 500);
  }
  const customer = await custResp.json();

  // 5. Create Subscription. start_at = +21 days (14-day trial + 7-day grace
  //    window) so Razorpay's first real charge fires AFTER the grace period
  //    runs out. ₹2 / $0.50 addon billed immediately on card auth.
  const startAt = Math.floor(Date.now() / 1000) + 21 * 24 * 60 * 60;
  const totalCount = plan.billing_cycle === "yearly" ? 5 : 12;
  const subResp = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: rzpAuth },
    body: JSON.stringify({
      plan_id: razorpayPlanId,
      customer_id: customer.id,
      total_count: totalCount,
      quantity: 1,
      start_at: startAt,
      customer_notify: 1,
      addons: [{ item: { name: "Verification charge", amount: verifyAmt, currency } }],
      notes: {
        pending_signup_id: pendingRow.id, email, org_name: orgName,
        plan_id: planId, currency,
      },
    }),
  });
  if (!subResp.ok) {
    const t = await subResp.text();
    return json({ error: `razorpay subscription: ${t}` }, 500);
  }
  const sub = await subResp.json();

  await admin
    .from("pending_signups")
    .update({ razorpay_subscription_id: sub.id, razorpay_customer_id: customer.id })
    .eq("id", pendingRow.id);

  return json({
    ok: true,
    key_id: KEY_ID,
    subscription_id: sub.id,
    customer_id: customer.id,
    pending_signup_id: pendingRow.id,
    short_url: sub.short_url,
    currency,
    auth_amount: verifyAmt / 100,
    auth_amount_label: useUSD ? `$${(verifyAmt / 100).toFixed(2)}` : `₹${verifyAmt / 100}`,
    plan_amount_label: useUSD
      ? (plan.price_usd != null ? `$${Number(plan.price_usd).toFixed(2)}` : "")
      : `₹${Number(plan.price_inr).toLocaleString("en-IN")}`,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
