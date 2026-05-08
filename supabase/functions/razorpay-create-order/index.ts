// POST /functions/v1/razorpay-create-order
// Headers: Authorization: Bearer <user JWT>
// Body: { invoice_id: string }
// Returns: { order_id, amount, currency, key_id, invoice_number }
//
// Caller must own the invoice (super-admin, partner-of-invoice, or org member).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RZP_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID") ?? "";
const RZP_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) return json({ error: "razorpay not configured" }, 500);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "missing user token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user) return json({ error: "invalid token" }, 401);

  let body: { invoice_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.invoice_id) return json({ error: "invoice_id required" }, 400);

  // RLS handles authorization — userClient can only see invoices they're allowed to.
  const { data: inv, error: invErr } = await userClient
    .from("invoices")
    .select("id, invoice_number, total_inr, status, razorpay_order_id")
    .eq("id", body.invoice_id)
    .maybeSingle();
  if (invErr) return json({ error: invErr.message }, 500);
  if (!inv) return json({ error: "invoice not found or not accessible" }, 404);
  if (inv.status === "paid") return json({ error: "already paid" }, 409);

  // Razorpay expects amount in paise
  const amountPaise = Math.round(Number(inv.total_inr) * 100);

  const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`)}`,
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: inv.invoice_number,
      notes: { invoice_id: inv.id, invoice_number: inv.invoice_number },
    }),
  });
  if (!orderRes.ok) {
    const t = await orderRes.text();
    return json({ error: `razorpay order failed: ${orderRes.status} ${t}` }, 502);
  }
  const order = await orderRes.json() as { id: string; amount: number; currency: string };

  // Persist order_id for the webhook to look up
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await admin.from("invoices").update({ razorpay_order_id: order.id }).eq("id", inv.id);

  return json({
    order_id: order.id,
    amount: order.amount,
    currency: order.currency,
    key_id: RZP_KEY_ID,
    invoice_number: inv.invoice_number,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
