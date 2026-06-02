// POST /functions/v1/razorpay-webhook
// Public, no JWT (Razorpay calls it directly). Signature verification mandatory.
//
// Razorpay dashboard → Webhooks → URL:
//   https://<project>.functions.supabase.co/razorpay-webhook
// Active events to enable:
//   • payment.captured                — invoice payments (existing flow)
//   • subscription.authenticated      — ₹2 verify ok → finalize self-signup
//   • subscription.charged            — recurring charge → extend license
//   • subscription.halted             — mandate revoked → suspend org
//   • subscription.cancelled          — customer cancelled → suspend org
//
// Set the same dashboard secret as RAZORPAY_WEBHOOK_SECRET project secret.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegration } from "../_shared/integrations.ts";
import { findAuthUserIdByEmail } from "../_shared/find-user.ts";

function hmacEqual(a: string, b: string): boolean {
  // Use a constant-time comparison so an attacker cannot recover the expected
  // HMAC byte-by-byte via response timing. Both sides are lowercase hex of the
  // same length when valid, so a length mismatch is itself a fail.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type SubEntity = {
  id?: string;
  customer_id?: string;
  status?: string;
  notes?: Record<string, string>;
};

type PayEntity = {
  id?: string;
  order_id?: string;
  status?: string;
  amount?: number;
  notes?: Record<string, string>;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const WEBHOOK_SECRET = await getIntegration("RAZORPAY_WEBHOOK_SECRET");
  if (!WEBHOOK_SECRET) return new Response("webhook not configured — set RAZORPAY_WEBHOOK_SECRET in /admin/integrations", { status: 500 });

  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const raw = await req.text();
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  if (!hmacEqual(signature, expected)) return new Response("invalid signature", { status: 401 });

  let event: {
    event: string;
    payload?: {
      payment?:      { entity?: PayEntity };
      subscription?: { entity?: SubEntity };
    };
  };
  try { event = JSON.parse(raw); } catch { return new Response("invalid json", { status: 400 }); }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const sub  = event.payload?.subscription?.entity;
  const pay  = event.payload?.payment?.entity;

  // Upgrade / add-on / trial-switch subscriptions stamp their intent in
  // `notes` when the subscription is created (see razorpay-create-upgrade).
  // Detect those FIRST — they take a different code path than signup
  // (no pending_signup row).
  const intent = (sub?.notes?.intent as string | undefined) ?? null;
  if (intent === "plan_switch" || intent === "addon_add" || intent === "trial_switch") {
    if (event.event === "subscription.authenticated" || event.event === "subscription.charged") {
      const orgId = sub?.notes?.org_id as string | undefined;
      const planCode = sub?.notes?.plan_code as string | undefined;
      if (!orgId || !planCode) return fail(`upgrade webhook missing notes: ${JSON.stringify(sub?.notes)}`);
      const seats = Number(sub?.notes?.seats ?? 0) || (intent === "plan_switch" ? 5 : intent === "addon_add" ? null : undefined);
      let rpc: string;
      let args: Record<string, unknown>;
      if (intent === "plan_switch") {
        rpc = "swap_org_plan";
        args = { p_org_id: orgId, p_new_plan_code: planCode, p_razorpay_subscription_id: sub!.id!, p_razorpay_customer_id: sub!.customer_id ?? null, p_seats: seats };
      } else if (intent === "trial_switch") {
        rpc = "swap_trial_plan";
        args = { p_org_id: orgId, p_new_plan_code: planCode, p_razorpay_subscription_id: sub!.id!, p_razorpay_customer_id: sub!.customer_id ?? null };
      } else {
        rpc = "activate_org_addon";
        args = { p_org_id: orgId, p_addon_plan_code: planCode, p_razorpay_subscription_id: sub!.id!, p_seats: seats };
      }
      const { error } = await admin.rpc(rpc, args);
      if (error) return fail(`${rpc}: ${error.message}`);

      // Generate invoice for the renewal / first-charge. Idempotent on
      // razorpay_payment_id so the verify-endpoint call (if any) and this
      // webhook call don't double-insert.
      if (event.event === "subscription.charged" && pay?.id && pay?.amount && intent !== "trial_switch") {
        try {
          const { data: planRow } = await admin
            .from("plans").select("price_inr").eq("code", planCode).eq("is_active", true).maybeSingle();
          const perSeat = Number((planRow as { price_inr?: number } | null)?.price_inr ?? 0);
          const expectedRupees = perSeat > 0 && seats ? perSeat * seats : null;
          const paidRupees = pay.amount / 100;
          // If we have a server-side expected total, refuse to invoice when the
          // amount Razorpay reports diverges by more than 1 rupee (covers
          // rounding) — protects against tampered notes / stale plan refs.
          if (expectedRupees !== null && Math.abs(expectedRupees - paidRupees) > 1) {
            console.warn(`[razorpay-webhook] amount mismatch org=${orgId} plan=${planCode} expected=${expectedRupees} paid=${paidRupees} — skipping invoice`);
            return ok({ event: event.event, intent, subscription_id: sub!.id, plan_code: planCode, invoice: "skipped_amount_mismatch" });
          }
          const totalRupees = expectedRupees ?? paidRupees;
          await admin.rpc("generate_billing_invoice", {
            p_org_id: orgId,
            p_amount_inr: totalRupees,
            p_plan_id: null,
            p_license_id: null,
            p_razorpay_order_id: pay.order_id ?? null,
            p_razorpay_payment_id: pay.id,
            p_kind: intent === "plan_switch" ? "renewal" : "addon",
            p_is_renewal: true,
          });
        } catch (e) {
          console.warn("invoice gen (webhook renewal):", (e as Error).message);
        }
      }

      return ok({ event: event.event, intent, subscription_id: sub!.id, plan_code: planCode });
    }
    // Other lifecycle events for upgrade subs (halted/cancelled) fall through
    // to the existing handlers below.
  }

  switch (event.event) {
    // ── ₹2 verification captured → create user, send invite, finalize org ──
    case "subscription.authenticated": {
      if (!sub?.id) return ok({ ignored: "no subscription id" });

      // Look up the pending row to grab the email/name we'll need to invite.
      const { data: pending } = await admin
        .from("pending_signups")
        .select("id, email, full_name_pending, user_id, status, organization_id")
        .eq("razorpay_subscription_id", sub.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!pending) return fail(`no pending_signup for subscription ${sub.id}`);

      // Idempotency — if we already finalized, no-op.
      if (pending.status === "completed" && pending.organization_id) {
        return ok({ event: event.event, subscription_id: sub.id, idempotent: true });
      }

      // 1. Create OR find the auth user. inviteUserByEmail creates+sends mail
      //    if the email is new; if it already exists, we just look it up.
      let userId: string | null = pending.user_id;
      if (!userId) {
        const existingId = pending.email ? await findAuthUserIdByEmail(admin, pending.email) : null;
        if (existingId) {
          userId = existingId;
        } else {
          const APP_URL = Deno.env.get("APP_URL") ?? "http://localhost:3000";
          const { data: invited, error: invErr } = await admin.auth.admin.inviteUserByEmail(pending.email!, {
            data: {
              full_name: pending.full_name_pending,
              invite_role: "customer_owner",
            },
            redirectTo: `${APP_URL}/post-login`,
          });
          if (invErr || !invited?.user) {
            return fail(`inviteUserByEmail: ${invErr?.message ?? "no user returned"}`);
          }
          userId = invited.user.id;
        }
      }

      // 2. Create org + license + membership tied to userId.
      const { error } = await admin.rpc("finalize_pending_signup_v2", {
        p_subscription_id: sub.id,
        p_user_id:         userId,
        p_customer_id:     sub.customer_id ?? null,
      });
      if (error) return fail(`finalize_pending_signup_v2: ${error.message}`);
      return ok({ event: event.event, subscription_id: sub.id, user_id: userId });
    }

    // ── Recurring charge captured → extend license one billing cycle ───────
    case "subscription.charged": {
      if (!sub?.id) return ok({ ignored: "no subscription id" });
      const { error } = await admin.rpc("extend_subscription_charged", {
        p_subscription_id: sub.id,
        p_payment_id:      pay?.id ?? null,
        p_amount_paise:    pay?.amount ?? null,
      });
      if (error) return fail(`extend_subscription_charged: ${error.message}`);
      return ok({ event: event.event, subscription_id: sub.id });
    }

    // ── Mandate revoked or customer cancelled ──────────────────────────────
    case "subscription.halted":
    case "subscription.cancelled": {
      if (!sub?.id) return ok({ ignored: "no subscription id" });
      const { error } = await admin.rpc("halt_subscription", {
        p_subscription_id: sub.id,
        p_reason:          event.event,
      });
      if (error) return fail(`halt_subscription: ${error.message}`);
      return ok({ event: event.event, subscription_id: sub.id });
    }

    // ── Old invoice payment flow (manual Bill button) ──────────────────────
    case "payment.captured": {
      const invoiceId = pay?.notes?.invoice_id ?? null;
      if (!invoiceId) return ok({ ignored: "no invoice_id in notes" });
      const { error } = await admin.rpc("mark_invoice_paid", {
        p_invoice_id:          invoiceId,
        p_razorpay_order_id:   pay?.order_id ?? null,
        p_razorpay_payment_id: pay?.id ?? null,
      });
      if (error) return fail(`mark_invoice_paid: ${error.message}`);
      return ok({ event: event.event, invoice_id: invoiceId });
    }

    default:
      return ok({ ignored: event.event });
  }
});

function ok(body: unknown) {
  return new Response(JSON.stringify({ ok: true, ...((body as object) ?? {}) }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}
function fail(msg: string) { return new Response(msg, { status: 500 }); }
