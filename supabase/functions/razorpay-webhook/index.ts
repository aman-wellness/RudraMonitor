// POST /functions/v1/razorpay-webhook
// Public, no JWT (Razorpay calls it directly). Signature verification is mandatory.
//
// Razorpay dashboard → Webhooks → URL: https://<project>.functions.supabase.co/razorpay-webhook
// Set Active Events: payment.captured, payment.failed (at minimum).
// Set the same secret as RAZORPAY_WEBHOOK_SECRET below.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { createHmac } from "node:crypto";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!WEBHOOK_SECRET) return new Response("webhook not configured", { status: 500 });

  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const raw = await req.text();
  const expected = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  if (signature !== expected) {
    return new Response("invalid signature", { status: 401 });
  }

  let event: {
    event: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; status?: string; notes?: Record<string, string> } };
    };
  };
  try { event = JSON.parse(raw); } catch { return new Response("invalid json", { status: 400 }); }

  const paymentId = event.payload?.payment?.entity?.id ?? null;
  const orderId   = event.payload?.payment?.entity?.order_id ?? null;
  const notes     = event.payload?.payment?.entity?.notes ?? {};
  const invoiceId = notes.invoice_id ?? null;

  if (event.event !== "payment.captured") {
    // We only act on captured. Failed/refunded handling can be added later.
    return new Response(JSON.stringify({ ok: true, ignored: event.event }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  if (!invoiceId) {
    return new Response("missing invoice_id in notes", { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Mark paid + extend license atomically via RPC
  const { error } = await admin.rpc("mark_invoice_paid", {
    p_invoice_id: invoiceId,
    p_razorpay_order_id: orderId,
    p_razorpay_payment_id: paymentId,
  });
  if (error) {
    return new Response(`mark_invoice_paid failed: ${error.message}`, { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, invoice_id: invoiceId }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
