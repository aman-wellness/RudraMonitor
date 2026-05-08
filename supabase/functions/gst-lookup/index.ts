// POST /functions/v1/gst-lookup
// Body: { gstin: string }
// Returns: { ok: boolean, data?: { legal_name, trade_name, address, pincode, state, status }, error? }
//
// Wraps a third-party GSTIN lookup API. We support two providers via env vars,
// in priority order:
//
//   1. Appyflow GST verification          GST_API_PROVIDER=appyflow,  GST_API_KEY=<key>
//   2. RapidAPI gst-return-status pattern  GST_API_PROVIDER=rapidapi, GST_API_KEY=<key>, GST_API_HOST=<host>
//
// Without a provider configured, returns a structural-decoded fallback (state code
// and PAN extracted from the GSTIN itself) so the UI still gets *something* useful.

import { corsHeaders } from "../_shared/cors.ts";

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const STATE_CODES: Record<string, string> = {
  "01":"Jammu and Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh",
  "05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan","09":"Uttar Pradesh",
  "10":"Bihar","11":"Sikkim","12":"Arunachal Pradesh","13":"Nagaland","14":"Manipur",
  "15":"Mizoram","16":"Tripura","17":"Meghalaya","18":"Assam","19":"West Bengal",
  "20":"Jharkhand","21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh","24":"Gujarat",
  "25":"Daman and Diu","26":"Dadra and Nagar Haveli","27":"Maharashtra","28":"Andhra Pradesh",
  "29":"Karnataka","30":"Goa","31":"Lakshadweep","32":"Kerala","33":"Tamil Nadu",
  "34":"Puducherry","35":"Andaman and Nicobar Islands","36":"Telangana","37":"Andhra Pradesh",
  "38":"Ladakh",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { gstin?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const gstin = (body.gstin ?? "").trim().toUpperCase();
  if (!GSTIN_REGEX.test(gstin)) {
    return json({ ok: false, error: "Invalid GSTIN format" }, 400);
  }

  const provider = (Deno.env.get("GST_API_PROVIDER") ?? "").toLowerCase();
  const apiKey = Deno.env.get("GST_API_KEY") ?? "";

  // No provider configured → structural fallback so the UI still autofills state + PAN.
  if (!provider || !apiKey) {
    return json({
      ok: true,
      source: "fallback",
      data: {
        legal_name: null,
        trade_name: null,
        address: null,
        pincode: null,
        state: STATE_CODES[gstin.slice(0, 2)] ?? null,
        pan: gstin.slice(2, 12),
        status: null,
      },
    });
  }

  try {
    if (provider === "appyflow") {
      const res = await fetch(`https://appyflow.in/api/verifyGST?gstNo=${encodeURIComponent(gstin)}&key_secret=${encodeURIComponent(apiKey)}`);
      const j = await res.json();
      if (!j?.taxpayerInfo) {
        return json({ ok: false, error: j?.message ?? "GSTIN not found" }, 404);
      }
      const ti = j.taxpayerInfo;
      const pradr = ti?.pradr?.addr ?? {};
      return json({
        ok: true,
        source: "appyflow",
        data: {
          legal_name: ti?.lgnm ?? null,
          trade_name: ti?.tradeNam ?? null,
          address: [pradr.bno, pradr.bnm, pradr.flno, pradr.st, pradr.loc].filter(Boolean).join(", ") || null,
          pincode: pradr.pncd ?? null,
          state: pradr.stcd ?? STATE_CODES[gstin.slice(0, 2)] ?? null,
          city: pradr.dst ?? null,
          pan: gstin.slice(2, 12),
          status: ti?.sts ?? null,
        },
      });
    }

    if (provider === "rapidapi") {
      const host = Deno.env.get("GST_API_HOST") ?? "";
      if (!host) return json({ error: "GST_API_HOST not set" }, 500);
      const res = await fetch(`https://${host}/gst/${encodeURIComponent(gstin)}`, {
        headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": host },
      });
      const j = await res.json();
      // shape varies — admin can adjust this branch when wiring their preferred provider.
      return json({ ok: true, source: "rapidapi", data: j });
    }

    return json({ error: `unknown provider: ${provider}` }, 500);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
