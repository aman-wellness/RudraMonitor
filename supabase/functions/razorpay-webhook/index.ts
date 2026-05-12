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
import { createHmac } from "node:crypto";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegration } from "../_shared/integrations.ts";

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
  if (signature !== expected) return new Response("invalid signature", { status: 401 });

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
        const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
        const existingUser = list?.users?.find((u) => u.email?.toLowerCase() === pending.email?.toLowerCase());
        if (existingUser) {
          userId = existingUser.id;
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
