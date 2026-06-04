// POST /functions/v1/razorpay-create-upgrade
//
// Authenticated. Creates a Razorpay Subscription for a paid upgrade from the
// customer's /checkout page. Two kinds of upgrades:
//   - kind='plan'  : main-plan switch (e.g. Starter → Professional). The new
//                    subscription's first charge IS the full plan price.
//   - kind='addon' : add-on activation (e.g. DLP). Separate Razorpay
//                    subscription per add-on so add-ons can be cancelled
//                    independently of the main plan.
//
// We DO NOT cancel any existing subscription here — the webhook does that
// after the new one is authenticated (so we don't lose the customer's access
// if they bail out of Checkout). `notes` on the new subscription carries the
// intent so the webhook knows what to do.
//
// On success returns { key_id, subscription_id, ... } for the browser to
// open Razorpay Checkout via the same helper as signup.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Body = {
  kind?: "plan" | "addon" | "trial_switch";
  plan_code?: string;
  currency?: "INR" | "USD";
  seats?: number;
};

const VERIFY_INR_PAISE = 200;   // ₹2.00 — same as signup
const VERIFY_USD_CENTS = 50;    // $0.50

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const kind     = body.kind ?? "plan";
  const planCode = (body.plan_code ?? "").trim();
  const currency = (body.currency ?? "INR").toUpperCase() as "INR" | "USD";
  // Default seats vary by product model:
  //   - EM plans (em-m / em-y): 1 — single-license multi-employee.
  //   - Monitoring trial-switch: 25 — test deployment.
  //   - Monitoring paid main plan: 5.
  //   - Add-ons: customer-picked, default 1.
  const isEmMain = (planCode.startsWith("em-") && !planCode.startsWith("em-addon-"));
  const fallbackSeats = kind === "trial_switch"
    ? (isEmMain ? 1 : 25)
    : kind === "plan"
      ? (isEmMain ? 1 : 5)
      : 1;
  const seats = Math.max(1, Math.min(10000, Math.floor(Number(body.seats) || fallbackSeats)));
  if (kind !== "plan" && kind !== "addon" && kind !== "trial_switch") {
    return json({ error: "kind must be 'plan', 'addon', or 'trial_switch'" }, 400);
  }
  if (!planCode) return json({ error: "plan_code required" }, 400);

  // Auth: must be a logged-in user. Resolve their org via owner_user_id.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return json({ error: "not authenticated" }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user?.id) return json({ error: "invalid token" }, 401);

  const { data: org } = await admin
    .from("organizations")
    .select("id, name, owner_user_id, razorpay_customer_id, razorpay_subscription_id, country, phone, license_count, subscription_status, trial_ends_at")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (!org) return json({ error: "no organization for this user" }, 404);

  if (kind === "trial_switch" && org.subscription_status !== "trial") {
    return json({ error: "trial_switch requires an org currently on a trial" }, 400);
  }
  if (kind === "plan" && org.subscription_status === "trial") {
    // Customer is still on a trial — main-plan changes go through trial_switch
    // (₹2 verify) rather than a full charge.
    return json({ error: "Use kind='trial_switch' while on a trial — full-charge plan changes are for paid orgs only." }, 400);
  }
  // Add-ons during trial: ALLOWED. The new Razorpay subscription's first
  // charge is pushed to (trial_ends_at + 7-day grace) so the customer
  // doesn't pay until the trial window closes — same UX as the main plan.

  // Load the plan + verify role consistency with the requested kind.
  const { data: plan, error: planErr } = await admin
    .from("plans")
    .select("id, code, name, is_addon, billing_cycle, razorpay_plan_id, razorpay_plan_id_usd, price_inr, price_usd")
    .eq("code", planCode)
    .eq("is_active", true)
    .maybeSingle();
  if (planErr || !plan) return json({ error: `plan ${planCode} not found` }, 400);
  if (kind === "addon" && !plan.is_addon) return json({ error: `${planCode} is not an add-on` }, 400);
  if (kind === "plan"  &&  plan.is_addon) return json({ error: `${planCode} is an add-on, not a main plan` }, 400);

  const useUSD = currency === "USD" && !!plan.razorpay_plan_id_usd;
  const razorpayPlanId = useUSD ? plan.razorpay_plan_id_usd : plan.razorpay_plan_id;
  if (!razorpayPlanId) {
    return json({ error: `Plan "${plan.name}" has no ${currency} Razorpay plan_id configured.` }, 400);
  }

  // Razorpay credentials.
  const cfg = await getIntegrations(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]);
  const KEY_ID = cfg.RAZORPAY_KEY_ID;
  const KEY_SECRET = cfg.RAZORPAY_KEY_SECRET;
  if (!KEY_ID || !KEY_SECRET) return json({ error: "Razorpay credentials not configured (Admin → Integrations)" }, 500);
  const rzpAuth = "Basic " + btoa(`${KEY_ID}:${KEY_SECRET}`);

  // Reuse the org's Razorpay customer if we already created one (signup did).
  // Otherwise create a fresh one so Razorpay has the email/phone for tax.
  let customerId = org.razorpay_customer_id as string | null;
  if (!customerId) {
    const custResp = await fetch("https://api.razorpay.com/v1/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: rzpAuth },
      body: JSON.stringify({
        name: org.name, email: user.email, contact: org.phone ?? undefined,
        fail_existing: 0,
        notes: { org_id: org.id, source: "wellness-extract-upgrade" },
      }),
    });
    if (!custResp.ok) {
      const t = await custResp.text();
      return json({ error: `razorpay customer: ${t}` }, 500);
    }
    const cust = await custResp.json();
    customerId = cust.id;
  }

  // total_count caps the billing — yearly = 5 years, monthly = 12 months —
  // Razorpay's "auto-stop". Customer can renew at the end.
  const totalCount = plan.billing_cycle === "yearly" ? 5 : 12;

  // For trial_switch the first real charge fires at the END of the grace
  // window (trial_ends_at + 7 days). For paid plan / addon, no delay — first
  // charge fires immediately on card authentication.
  const subBody: Record<string, unknown> = {
    plan_id: razorpayPlanId,
    customer_id: customerId,
    total_count: totalCount,
    quantity: seats,
    customer_notify: 1,
    notes: {
      intent: kind === "plan" ? "plan_switch" : kind === "trial_switch" ? "trial_switch" : "addon_add",
      org_id: org.id,
      plan_code: planCode,
      currency,
      seats: String(seats),
    },
  };

  if (kind === "trial_switch") {
    // ₹2 / $0.50 verification addon — charged immediately on card auth so we
    // know the new card works. Same pattern as fresh signup.
    const verifyAmt = useUSD ? VERIFY_USD_CENTS : VERIFY_INR_PAISE;
    subBody.addons = [{ item: { name: "Trial-switch verification charge", amount: verifyAmt, currency } }];

    // Push first real billing to (trial_ends_at + 7 days) — the grace
    // window. trial_ends_at is in DB; fall back to +21 days if missing.
    const trialEndMs = org.trial_ends_at ? new Date(org.trial_ends_at as string).getTime() : (Date.now() + 14 * 24 * 60 * 60 * 1000);
    subBody.start_at = Math.floor((trialEndMs + 7 * 24 * 60 * 60 * 1000) / 1000);
  } else if (kind === "addon" && org.subscription_status === "trial") {
    // Add-on activated DURING a trial. Don't charge until the trial+grace
    // window closes — push first charge to (trial_ends_at + 7 days) so the
    // customer's billing aligns with the main plan's auto-charge moment.
    const trialEndMs = org.trial_ends_at ? new Date(org.trial_ends_at as string).getTime() : (Date.now() + 14 * 24 * 60 * 60 * 1000);
    subBody.start_at = Math.floor((trialEndMs + 7 * 24 * 60 * 60 * 1000) / 1000);
  }

  const subResp = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: rzpAuth },
    body: JSON.stringify(subBody),
  });
  if (!subResp.ok) {
    const t = await subResp.text();
    return json({ error: `razorpay subscription: ${t}` }, 500);
  }
  const sub = await subResp.json();

  // For trial_switch and paid plan_switch, cancel the org's existing Razorpay
  // subscription (best-effort — never block the new sub on cancel failure).
  if ((kind === "trial_switch" || kind === "plan") && org.razorpay_subscription_id) {
    const cancelResp = await fetch(`https://api.razorpay.com/v1/subscriptions/${org.razorpay_subscription_id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: rzpAuth },
      body: JSON.stringify({ cancel_at_cycle_end: 0 }),
    });
    if (!cancelResp.ok) {
      console.warn(`razorpay-create-upgrade: could not cancel old sub ${org.razorpay_subscription_id}: ${await cancelResp.text()}`);
    }
  }

  const planPrice = useUSD ? (plan.price_usd ?? 0) : (plan.price_inr ?? 0);
  const priceLabel = useUSD ? `$${Number(planPrice).toFixed(2)}` : `₹${Number(planPrice).toLocaleString("en-IN")}`;

  const total = planPrice * seats;
  const totalLabel = useUSD ? `$${Number(total).toFixed(2)}` : `₹${Number(total).toLocaleString("en-IN")}`;

  return json({
    ok: true,
    key_id: KEY_ID,
    subscription_id: sub.id,
    customer_id: customerId,
    currency,
    plan_code: planCode,
    plan_name: plan.name,
    billing_cycle: plan.billing_cycle,
    kind,
    seats,
    plan_price_label: `${priceLabel} / seat / ${plan.billing_cycle === "yearly" ? "year" : "month"}`,
    total_label: `${totalLabel} / ${plan.billing_cycle === "yearly" ? "year" : "month"} (${seats} seats)`,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
