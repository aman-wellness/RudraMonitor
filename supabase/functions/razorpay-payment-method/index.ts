// POST /functions/v1/razorpay-payment-method
// Body: { payment_id: "pay_XXX" }
//
// Fetches the Razorpay payment object and returns a human-friendly label
// describing how the customer paid — used by the invoice page in place of
// the bare payment_id. Examples:
//   { method: "card",    label: "VISA · 4242" }
//   { method: "upi",     label: "UPI · 9991675988@ybl" }
//   { method: "netbanking", label: "HDFC Bank" }
//   { method: "wallet",  label: "Paytm Wallet" }
//
// Auth: caller must be logged in (we don't want anyone scraping payment
// metadata). We don't lock to invoice-ownership because Razorpay payment
// IDs are not enumerable from outside.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  let body: { payment_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const payId = (body.payment_id ?? "").trim();
  if (!payId.startsWith("pay_")) return json({ error: "valid payment_id required" }, 400);

  const cfg = await getIntegrations(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]);
  const KEY_ID = cfg.RAZORPAY_KEY_ID;
  const KEY_SECRET = cfg.RAZORPAY_KEY_SECRET;
  if (!KEY_ID || !KEY_SECRET) return json({ error: "Razorpay keys missing" }, 500);
  const rzpAuth = "Basic " + btoa(`${KEY_ID}:${KEY_SECRET}`);

  const r = await fetch(`https://api.razorpay.com/v1/payments/${payId}`, {
    headers: { Authorization: rzpAuth },
  });
  if (!r.ok) {
    const t = await r.text();
    return json({ error: `razorpay fetch payment: ${t}` }, 500);
  }
  const pay = await r.json() as RazorpayPayment;

  return json({
    ok: true,
    method: pay.method,
    label: humanLabel(pay),
    raw: {
      method: pay.method,
      card: pay.card ? { network: pay.card.network, last4: pay.card.last4, type: pay.card.type } : undefined,
      vpa: pay.vpa ?? undefined,
      bank: pay.bank ?? undefined,
      wallet: pay.wallet ?? undefined,
    },
  });
});

interface RazorpayPayment {
  method: string;
  card?: { network?: string; last4?: string; type?: string; issuer?: string };
  vpa?: string;
  bank?: string;
  wallet?: string;
  emi?: boolean;
}

function humanLabel(p: RazorpayPayment): string {
  switch (p.method) {
    case "card": {
      const network = p.card?.network ?? "Card";
      const last4 = p.card?.last4 ? ` · ${p.card.last4}` : "";
      const type = p.card?.type ? ` (${p.card.type})` : "";
      return `${network}${last4}${type}`;
    }
    case "upi": {
      return p.vpa ? `UPI · ${p.vpa}` : "UPI";
    }
    case "netbanking": {
      return p.bank ? `Netbanking · ${p.bank}` : "Netbanking";
    }
    case "wallet": {
      return p.wallet ? `Wallet · ${prettyCase(p.wallet)}` : "Wallet";
    }
    case "emi": return "EMI";
    case "paylater": return "Pay Later";
    default: return prettyCase(p.method ?? "Online payment");
  }
}

function prettyCase(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
