// POST /functions/v1/razorpay-add-seats-verify
// Headers: Authorization: Bearer <user JWT>
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
//
// Verifies the HMAC over `order_id|payment_id`, then:
//   1. Calls add_seats_to_active_license RPC → bumps license + org seat_count
//   2. Updates the org's existing Razorpay subscription quantity so the NEXT
//      renewal charges for the new total. Best-effort — DB is authoritative.

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

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  let body: { razorpay_order_id?: string; razorpay_payment_id?: string; razorpay_signature?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const orderId = (body.razorpay_order_id ?? "").trim();
  const payId   = (body.razorpay_payment_id ?? "").trim();
  const sigGot  = (body.razorpay_signature ?? "").trim();
  if (!orderId || !payId || !sigGot) {
    return json({ error: "order_id + payment_id + signature required" }, 400);
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

  const cfg = await getIntegrations(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]);
  const KEY_ID = cfg.RAZORPAY_KEY_ID;
  const KEY_SECRET = cfg.RAZORPAY_KEY_SECRET;
  if (!KEY_ID || !KEY_SECRET) return json({ error: "Razorpay keys missing." }, 500);

  // 1. HMAC verify — Order-mode signature is over "order_id|payment_id".
  const expected = createHmac("sha256", KEY_SECRET).update(`${orderId}|${payId}`).digest("hex");
  const okSig = (() => {
    try {
      const a = Buffer.from(sigGot, "hex");
      const b = Buffer.from(expected, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  })();
  if (!okSig) return json({ ok: false, error: "signature mismatch", fatal: true }, 200);

  // 2. Fetch order to read notes (intent, org_id, extra_seats, plan_code, sub_id).
  const rzpAuth = "Basic " + btoa(`${KEY_ID}:${KEY_SECRET}`);
  const orderResp = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, {
    headers: { Authorization: rzpAuth },
  });
  if (!orderResp.ok) {
    const t = await orderResp.text();
    return json({ ok: false, error: `fetch order: ${t}` }, 200);
  }
  const order = await orderResp.json() as {
    id: string; amount: number; notes?: Record<string, string>; status?: string;
  };
  const intent   = order.notes?.intent;
  const orgId    = order.notes?.org_id;
  const extra    = Number(order.notes?.extra_seats ?? 0);
  const subId    = order.notes?.razorpay_subscription_id;
  if (intent !== "add_seats" || !orgId || !extra) {
    return json({ ok: false, error: "order is not an add-seats order", fatal: true }, 200);
  }

  // 3. Authorization: caller must own the org.
  const { data: org } = await admin
    .from("organizations").select("id, owner_user_id, razorpay_subscription_id").eq("id", orgId).maybeSingle();
  if (!org) return json({ ok: false, error: "org not found", fatal: true }, 200);
  if (org.owner_user_id !== u.user.id) {
    return json({ ok: false, error: "order belongs to a different account", fatal: true }, 403);
  }

  // 4. Bump seats in DB.
  const { data: rpcRow, error: rpcErr } = await admin
    .rpc("add_seats_to_active_license", {
      p_org_id: orgId,
      p_extra_seats: extra,
      p_razorpay_payment_id: payId,
      p_prorated_amount_paise: order.amount,
    });
  if (rpcErr) return json({ ok: false, error: `add_seats: ${rpcErr.message}` }, 200);

  // 5. Best-effort: bump Razorpay subscription quantity so the NEXT cycle
  // renews for the new total. If this fails, the DB is still correct — we
  // can reconcile later. Skip if no subscription_id linked.
  const targetSubId = subId || org.razorpay_subscription_id;
  if (targetSubId) {
    try {
      const { data: lic } = await admin
        .from("licenses").select("seat_count")
        .eq("organization_id", orgId).eq("status", "active")
        .order("issued_at", { ascending: false }).limit(1).maybeSingle();
      const newQty = Math.max(1, Number((lic as { seat_count?: number } | null)?.seat_count ?? 0));
      const updResp = await fetch(`https://api.razorpay.com/v1/subscriptions/${targetSubId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: rzpAuth },
        body: JSON.stringify({
          quantity: newQty,
          schedule_change_at: "cycle_end",
        }),
      });
      if (!updResp.ok) {
        console.warn(`razorpay sub update failed: ${await updResp.text()}`);
      }
    } catch (e) {
      console.warn("razorpay sub quantity update threw:", (e as Error).message);
    }
  }

  type RpcRow = { new_license_count: number; license_id: string };
  const row = Array.isArray(rpcRow) ? (rpcRow[0] as RpcRow | undefined) : (rpcRow as RpcRow | undefined);

  // Generate invoice for the prorated charge.
  try {
    await admin.rpc("generate_billing_invoice", {
      p_org_id: orgId,
      p_amount_inr: order.amount / 100,   // paise → rupees
      p_plan_id: null,
      p_license_id: row?.license_id ?? null,
      p_razorpay_order_id: orderId,
      p_razorpay_payment_id: payId,
      p_kind: "seats",
      p_is_renewal: false,
    });
  } catch (e) {
    console.warn("invoice gen (add-seats):", (e as Error).message);
  }

  return json({
    ok: true,
    org_id: orgId,
    extra_seats: extra,
    new_total: row?.new_license_count ?? null,
    prorated_paise: order.amount,
  });
});

const Buffer = {
  from(s: string, enc: "hex"): Uint8Array {
    if (enc !== "hex") throw new Error("unsupported");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
