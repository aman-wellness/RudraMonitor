// POST /functions/v1/razorpay-verify-upgrade
// Headers: Authorization: Bearer <user JWT>
// Body: {
//   subscription_id, razorpay_payment_id, razorpay_signature
// }
//
// Sub-second finalize for paid plan / trial-switch / add-on upgrades.
// Razorpay's Checkout SDK fires `handler()` the instant the card mandate
// is authorised. We verify the signature with HMAC and immediately call
// the right RPC (swap_org_plan / swap_trial_plan / activate_org_addon)
// based on the subscription's `notes.intent`. No webhook wait.
//
// The `subscription.authenticated` / `subscription.charged` webhook
// remains as a redundant safety net — every RPC is idempotent.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { createHmac, timingSafeEqual } from "node:crypto";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = bearer(req);
  if (!jwt) return json({ error: "missing user token" }, 401);

  let body: {
    subscription_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const subId  = (body.subscription_id ?? "").trim();
  const payId  = (body.razorpay_payment_id ?? "").trim();
  const sigGot = (body.razorpay_signature ?? "").trim();
  if (!subId || !payId || !sigGot) {
    return json({ error: "subscription_id + razorpay_payment_id + razorpay_signature required" }, 400);
  }
  // SECURITY: subId is interpolated into the Razorpay URL below. Razorpay
  // subscription IDs look like "sub_<14 alphanumeric>" and payment IDs like
  // "pay_<14 alphanumeric>". Reject anything else so a crafted value can't
  // path-traverse or smuggle URL bytes.
  if (!/^sub_[A-Za-z0-9]{8,32}$/.test(subId)) {
    return json({ error: "invalid subscription_id format" }, 400);
  }
  if (!/^pay_[A-Za-z0-9]{8,32}$/.test(payId)) {
    return json({ error: "invalid payment_id format" }, 400);
  }
  if (!/^[a-f0-9]{64}$/.test(sigGot)) {
    return json({ error: "invalid signature format" }, 400);
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

  // 1. HMAC signature.
  const cfg = await getIntegrations(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]);
  const keyId     = cfg.RAZORPAY_KEY_ID;
  const keySecret = cfg.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return json({ error: "razorpay keys missing on server" }, 500);
  const expected = createHmac("sha256", keySecret).update(`${payId}|${subId}`).digest("hex");
  const okSig = (() => {
    try {
      const a = Buffer.from(sigGot, "hex");
      const b = Buffer.from(expected, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  })();
  if (!okSig) return json({ ok: false, error: "signature mismatch", fatal: true }, 200);

  // 2. Fetch the subscription from Razorpay to read its `notes` (intent,
  //    org_id, plan_code, seats). We don't trust client-provided values —
  //    notes were stamped by razorpay-create-upgrade and are sealed.
  const rzpAuth = "Basic " + btoa(`${keyId}:${keySecret}`);
  const subResp = await fetch(`https://api.razorpay.com/v1/subscriptions/${subId}`, {
    headers: { Authorization: rzpAuth },
  });
  if (!subResp.ok) {
    const t = await subResp.text();
    return json({ ok: false, error: `razorpay fetch sub: ${t}` }, 200);
  }
  const sub = await subResp.json() as {
    id: string;
    customer_id?: string;
    notes?: Record<string, string>;
  };
  const intent   = sub.notes?.intent;
  const orgId    = sub.notes?.org_id;
  const planCode = sub.notes?.plan_code;
  const seats    = Number(sub.notes?.seats ?? 0);
  if (!intent || !orgId || !planCode) {
    return json({ ok: false, error: "subscription notes missing intent/org/plan", fatal: true }, 200);
  }

  // 3. Authorisation: the caller must own the org named in notes.
  const { data: org } = await admin
    .from("organizations").select("id, owner_user_id").eq("id", orgId).maybeSingle();
  if (!org) return json({ ok: false, error: "org not found", fatal: true }, 200);
  if (org.owner_user_id !== u.user.id) {
    return json({ ok: false, error: "subscription belongs to a different account", fatal: true }, 403);
  }

  // 4. Dispatch to the right RPC.
  let rpcName: string;
  // deno-lint-ignore no-explicit-any
  let args: Record<string, any>;
  if (intent === "plan_switch") {
    rpcName = "swap_org_plan";
    args = {
      p_org_id: orgId,
      p_new_plan_code: planCode,
      p_razorpay_subscription_id: subId,
      p_razorpay_customer_id: sub.customer_id ?? null,
      p_seats: seats > 0 ? seats : 5,
    };
  } else if (intent === "trial_switch") {
    rpcName = "swap_trial_plan";
    args = {
      p_org_id: orgId,
      p_new_plan_code: planCode,
      p_razorpay_subscription_id: subId,
      p_razorpay_customer_id: sub.customer_id ?? null,
    };
  } else if (intent === "addon_add") {
    rpcName = "activate_org_addon";
    args = {
      p_org_id: orgId,
      p_addon_plan_code: planCode,
      p_razorpay_subscription_id: subId,
      p_seats: seats > 0 ? seats : null,
    };
  } else {
    return json({ ok: false, error: `unknown intent: ${intent}`, fatal: true }, 200);
  }

  const { error: rpcErr } = await admin.rpc(rpcName, args);
  if (rpcErr) {
    // Idempotent RPCs — if the webhook already finished, treat as success.
    return json({ ok: false, error: `${rpcName}: ${rpcErr.message}` }, 200);
  }

  // Generate the customer's invoice. trial_switch is a ₹2 verify (charge
  // happens at trial+grace end via subscription renewal); plan_switch /
  // addon_add charge immediately so we issue the invoice now.
  try {
    if (intent === "plan_switch" || intent === "addon_add") {
      // Look up the plan's per-seat price + total = seats * price.
      const { data: planRow } = await admin
        .from("plans").select("price_inr").eq("code", planCode).maybeSingle();
      const perSeat = Number((planRow as { price_inr?: number } | null)?.price_inr ?? 0);
      const total   = perSeat * Math.max(1, seats || 1);
      if (total > 0) {
        await admin.rpc("generate_billing_invoice", {
          p_org_id: orgId,
          p_amount_inr: total,
          p_plan_id: null,
          p_license_id: null,
          p_razorpay_order_id: null,
          p_razorpay_payment_id: payId,
          p_kind: intent === "plan_switch" ? "upgrade" : "addon",
          p_is_renewal: false,
        });
      }
    } else if (intent === "trial_switch") {
      await admin.rpc("generate_billing_invoice", {
        p_org_id: orgId,
        p_amount_inr: 2,
        p_plan_id: null,
        p_license_id: null,
        p_razorpay_order_id: null,
        p_razorpay_payment_id: payId,
        p_kind: "trial_verify",
        p_is_renewal: false,
      });
    }
  } catch (e) {
    console.warn("invoice gen (verify-upgrade):", (e as Error).message);
  }

  return json({ ok: true, intent, org_id: orgId, plan_code: planCode }, 200);
});

const Buffer = {
  from(s: string, enc: "hex"): Uint8Array {
    if (enc !== "hex") throw new Error("unsupported");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  },
};

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
