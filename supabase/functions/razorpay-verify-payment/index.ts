// POST /functions/v1/razorpay-verify-payment
// Headers: Authorization: Bearer <user JWT>
// Body:    {
//   subscription_id:        string,   // sub_XXXX from start-signup
//   razorpay_payment_id:    string,   // pay_XXXX from Razorpay handler
//   razorpay_signature:     string,   // HMAC the SDK gives us
// }
//
// Sub-second finalize for the ₹2 card-verification flow. Razorpay's
// Checkout SDK fires `handler()` the instant the modal closes — by which
// time the bank has already approved the ₹2 charge. The handler payload
// contains a signature Razorpay computes locally on its server. We verify
// the signature with HMAC and immediately call `finalize_pending_signup_v2`
// — no polling, no Razorpay API round-trip. Total: < 1 second.
//
// The `subscription.authenticated` webhook still runs as a redundant
// safety net (finalize RPC is idempotent).
//
// Signature formula (Razorpay docs):
//   generated = hmac_sha256(payment_id + '|' + subscription_id, KEY_SECRET)
//   compare to razorpay_signature, constant-time.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { createHmac, timingSafeEqual } from "node:crypto";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";
import { findAuthUserIdByEmail } from "../_shared/find-user.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://ems.wellnessextract.com";

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
  const subId   = (body.subscription_id ?? "").trim();
  const payId   = (body.razorpay_payment_id ?? "").trim();
  const sigGot  = (body.razorpay_signature ?? "").trim();
  if (!subId || !payId || !sigGot) {
    return json({ error: "subscription_id + razorpay_payment_id + razorpay_signature required" }, 400);
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);
  const callerEmail = (u.user.email ?? "").toLowerCase();

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. HMAC signature — proves Razorpay generated this payment. No Razorpay
  //    API call needed; signature alone is sufficient per their docs.
  const cfg = await getIntegrations(["RAZORPAY_KEY_SECRET"]);
  const keySecret = cfg.RAZORPAY_KEY_SECRET;
  if (!keySecret) return json({ error: "razorpay key missing on server" }, 500);
  const expected = createHmac("sha256", keySecret).update(`${payId}|${subId}`).digest("hex");
  const okSig = (() => {
    try {
      const a = Buffer.from(sigGot, "hex");
      const b = Buffer.from(expected, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  })();
  if (!okSig) return json({ ok: false, error: "signature mismatch", fatal: true }, 200);

  // 2. Find the pending_signup row (also confirms this subscription belongs
  //    to a real Rudrans signup, not an arbitrary Razorpay sub).
  const { data: pending } = await admin
    .from("pending_signups")
    .select("id, email, full_name_pending, user_id, status, organization_id, razorpay_customer_id")
    .eq("razorpay_subscription_id", subId)
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  if (!pending) {
    return json({ ok: false, error: "subscription not recognised — please reload and try again", fatal: true }, 200);
  }
  if (pending.email && pending.email.toLowerCase() !== callerEmail && pending.user_id !== u.user.id) {
    return json({ ok: false, error: "subscription belongs to a different account", fatal: true }, 403);
  }

  // 3. Idempotency.
  if (pending.status === "completed" && pending.organization_id) {
    return json({ ok: true, org_id: pending.organization_id, idempotent: true }, 200);
  }

  // 4. Resolve / create the auth user (caller IS the user 99% of the time,
  //    since they're already signed in — fast path).
  let userId: string | null = pending.user_id;
  if (!userId) {
    if (callerEmail && pending.email && callerEmail === pending.email.toLowerCase()) {
      userId = u.user.id;
    } else if (pending.email) {
      // Edge case: customer used a different email at signup vs Razorpay.
      // Search by signup email; invite if truly new.
      const existingId = await findAuthUserIdByEmail(admin, pending.email);
      if (existingId) {
        userId = existingId;
      } else {
        const { data: invited, error: invErr } = await admin.auth.admin.inviteUserByEmail(pending.email, {
          data: { full_name: pending.full_name_pending, invite_role: "customer_owner" },
          redirectTo: `${APP_URL}/post-login`,
        });
        if (invErr || !invited?.user) {
          return json({ ok: false, error: `invite: ${invErr?.message ?? "no user"}`, fatal: true }, 200);
        }
        userId = invited.user.id;
      }
    }
  }
  if (!userId) return json({ ok: false, error: "could not resolve user", fatal: true }, 200);

  // 5. Finalize. Same RPC the webhook uses. Idempotent on the DB side.
  const { error: rpcErr } = await admin.rpc("finalize_pending_signup_v2", {
    p_subscription_id: subId,
    p_user_id:         userId,
    p_customer_id:     pending.razorpay_customer_id ?? null,
  });
  if (rpcErr) {
    // Race with the webhook — re-read; if it's done already, return the org.
    const { data: row } = await admin
      .from("pending_signups").select("organization_id").eq("id", pending.id).maybeSingle();
    if (row?.organization_id) return json({ ok: true, org_id: row.organization_id, idempotent: true }, 200);
    return json({ ok: false, error: `finalize: ${rpcErr.message}` }, 200);
  }

  // 6. Read back the just-set organization_id.
  const { data: done } = await admin
    .from("pending_signups").select("organization_id").eq("id", pending.id).maybeSingle();

  // 7. Best-effort: generate a tax-compliant invoice for the ₹2/$0.50 card
  // verification charge so the customer has a receipt on file. The full
  // first-cycle charge fires at trial+grace end via the Razorpay
  // subscription and gets its own invoice via the webhook handler.
  const orgIdFromPending = (done as { organization_id?: string } | null)?.organization_id;
  if (orgIdFromPending) {
    try {
      await admin.rpc("generate_billing_invoice", {
        p_org_id: orgIdFromPending,
        p_amount_inr: 2,
        p_plan_id: null,
        p_license_id: null,
        p_razorpay_order_id: null,
        p_razorpay_payment_id: payId,
        p_kind: "trial_verify",
        p_is_renewal: false,
      });
    } catch (e) {
      console.warn("invoice gen (verify-payment):", (e as Error).message);
    }
  }

  return json({ ok: true, org_id: orgIdFromPending, user_id: userId }, 200);
});

// Tiny Buffer shim for Deno — Node:crypto's timingSafeEqual wants a Buffer.
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
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
