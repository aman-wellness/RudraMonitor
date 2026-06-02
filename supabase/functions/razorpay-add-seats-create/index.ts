// POST /functions/v1/razorpay-add-seats-create
// Headers: Authorization: Bearer <user JWT>
// Body: { extra_seats: number }
//
// Customer wants to add seats to their EXISTING active subscription without
// switching plans. We:
//   1. Read the org's active main-plan license + current Razorpay subscription
//   2. Fetch the live subscription from Razorpay to learn `current_end` (the
//      next renewal moment) and `current_start` (this cycle's beginning)
//   3. Compute a prorated price covering ONLY the days left in this cycle
//      for the new seats
//   4. Create a Razorpay ORDER (one-time charge, not a recurring sub) tagged
//      with intent='add_seats' + extra_seats so the verify endpoint can
//      apply the bump after payment.
//
// On next renewal, the existing subscription's billing should pick up the
// new seat count — verify also calls Razorpay's "Update Subscription"
// endpoint to bump quantity for future cycles. Best-effort; the DB row is
// authoritative even if Razorpay's quantity update fails.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  let body: { extra_seats?: number };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const extra = Math.floor(Number(body.extra_seats ?? 0));
  if (!extra || extra <= 0 || extra > 10000) {
    return json({ error: "extra_seats must be between 1 and 10000" }, 400);
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Resolve org owned by caller.
  const { data: org } = await admin
    .from("organizations")
    .select("id, name, razorpay_subscription_id, razorpay_customer_id, subscription_status, license_count, country, phone")
    .eq("owner_user_id", u.user.id)
    .maybeSingle();
  if (!org) return json({ error: "no organization for this user" }, 404);
  if (org.subscription_status !== "active") {
    return json({ error: "Add-seats only applies to active paid subscriptions. Trial customers already have 25 seats." }, 400);
  }
  // razorpay_subscription_id is OPTIONAL — legacy / manually-provisioned
  // orgs don't have one. We still let them add seats: compute proration
  // from the license's issue date instead, and skip the Razorpay-side
  // subscription quantity sync (done by verify endpoint if subscription_id
  // is present).

  // 2. Active main-plan license tells us the plan + per-seat price.
  const { data: lic } = await admin
    .from("licenses")
    .select("id, plan_id, seat_count, issued_at, plans!inner(code, name, price_inr, price_usd, billing_cycle, razorpay_plan_id, razorpay_plan_id_usd, is_addon)")
    .eq("organization_id", org.id)
    .eq("status", "active")
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  type LicRow = { id: string; plan_id: string; seat_count: number; issued_at: string;
    plans: { code: string; name: string; price_inr: number; price_usd: number;
             billing_cycle: string; razorpay_plan_id: string | null;
             razorpay_plan_id_usd: string | null; is_addon: boolean } |
           { code: string; name: string; price_inr: number; price_usd: number;
             billing_cycle: string; razorpay_plan_id: string | null;
             razorpay_plan_id_usd: string | null; is_addon: boolean }[] };
  const licRow = lic as LicRow | null;
  if (!licRow) return json({ error: "No active license found." }, 400);
  const plan = Array.isArray(licRow.plans) ? licRow.plans[0] : licRow.plans;
  if (!plan || plan.is_addon) return json({ error: "Active license isn't on a main plan." }, 400);
  if (plan.code.startsWith("em-") && !plan.code.startsWith("em-addon-")) {
    return json({ error: "Employee Management is a single-license product — can't add seats." }, 400);
  }

  // 3. Razorpay credentials (always needed for order creation).
  const cfg = await getIntegrations(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]);
  const KEY_ID = cfg.RAZORPAY_KEY_ID;
  const KEY_SECRET = cfg.RAZORPAY_KEY_SECRET;
  if (!KEY_ID || !KEY_SECRET) return json({ error: "Razorpay keys missing on server." }, 500);
  const rzpAuth = "Basic " + btoa(`${KEY_ID}:${KEY_SECRET}`);

  // 4. Cycle window. If org has a Razorpay subscription, ask Razorpay for
  // current_end (most accurate). Otherwise compute from license issue_at
  // assuming a standard monthly/yearly cycle.
  const now = Math.floor(Date.now() / 1000);
  const cycleSecs = plan.billing_cycle === "yearly" ? 365 * 86400 : 30 * 86400;
  const cycleDays = plan.billing_cycle === "yearly" ? 365 : 30;
  let cycleEnd = now + cycleSecs;
  if (org.razorpay_subscription_id) {
    const subResp = await fetch(`https://api.razorpay.com/v1/subscriptions/${org.razorpay_subscription_id}`, {
      headers: { Authorization: rzpAuth },
    });
    if (subResp.ok) {
      const sub = await subResp.json() as { current_end?: number; charge_at?: number };
      cycleEnd = sub.current_end ?? sub.charge_at ?? cycleEnd;
    }
  } else if (licRow.issued_at) {
    // Compute from license issue date — assume cycles roll over monthly/yearly.
    const licIssuedSecs = Math.floor(new Date(licRow.issued_at).getTime() / 1000);
    const elapsed = now - licIssuedSecs;
    const cyclesPassed = Math.floor(elapsed / cycleSecs);
    cycleEnd = licIssuedSecs + (cyclesPassed + 1) * cycleSecs;
  }
  const daysLeft = Math.max(1, Math.ceil((cycleEnd - now) / 86400));
  // INR-first (we charge in INR via prorated Orders; international can switch later).
  const perSeat = Number(plan.price_inr);  // ₹
  const proratedRupees = (perSeat * extra * daysLeft) / cycleDays;
  // Round UP to the nearest ₹1 — never under-charge.
  const amountPaise = Math.max(1, Math.ceil(proratedRupees)) * 100;

  // 5. Create a Razorpay Order (one-time payment).
  const orderResp = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: rzpAuth },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: `seats_${org.id.slice(0, 8)}_${Date.now()}`,
      notes: {
        intent: "add_seats",
        org_id: org.id,
        plan_code: plan.code,
        extra_seats: String(extra),
        days_left: String(daysLeft),
        razorpay_subscription_id: org.razorpay_subscription_id ?? "",
      },
    }),
  });
  if (!orderResp.ok) {
    const t = await orderResp.text();
    return json({ error: `razorpay order: ${t}` }, 500);
  }
  const order = await orderResp.json() as { id: string; amount: number; currency: string };

  return json({
    ok: true,
    key_id: KEY_ID,
    order_id: order.id,
    amount: order.amount,
    currency: order.currency,
    days_left: daysLeft,
    cycle_days: cycleDays,
    per_seat_inr: perSeat,
    extra_seats: extra,
    plan_name: plan.name,
    label: `₹${Math.ceil(proratedRupees).toLocaleString("en-IN")} for ${extra} seat${extra === 1 ? '' : 's'} × ${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining`,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
