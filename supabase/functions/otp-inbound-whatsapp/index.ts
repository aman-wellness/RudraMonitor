// Meta Cloud API webhook for WhatsApp Business inbound messages.
//
// Two handlers on the same path:
//
//   GET /functions/v1/otp-inbound-whatsapp?org=<org_id>
//        &hub.mode=subscribe
//        &hub.verify_token=<token>
//        &hub.challenge=<nonce>
//     One-time setup ping from Meta. We compare the verify_token against
//     integrations.WHATSAPP_VERIFY_TOKEN and echo the challenge back.
//
//   POST /functions/v1/otp-inbound-whatsapp?org=<org_id>
//     Normal inbound message event. We optionally verify the X-Hub-
//     Signature-256 HMAC against the app-secret. Payload is the standard
//     Meta WhatsApp `entry → changes → value → messages[]` envelope.
//
// We only react to text messages (button-replies could be added later if
// the OTP template includes a quick-reply button).

import { corsHeaders } from "../_shared/cors.ts";
import { ingestInbound } from "../_shared/otp-inbound.ts";
import { getIntegration } from "../_shared/integrations.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const orgId = (url.searchParams.get("org") ?? "").trim();
  if (!orgId) return new Response("missing ?org=<uuid>", { status: 400 });

  // ── GET verification ───────────────────────────────────────────────────
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    const expected = await getIntegration("WHATSAPP_VERIFY_TOKEN").catch(() => "");
    if (mode === "subscribe" && expected && verifyToken === expected) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();

  // Optional signature verification — Meta sends `X-Hub-Signature-256:
  // sha256=<hex>` computed over the raw body with the app-secret.
  // SECURITY (audit H7): when the app secret is configured, the signature is
  // MANDATORY. The former `appSecret && sigHeader.startsWith(...)` meant an
  // attacker who simply OMITTED the header skipped verification entirely and
  // could forge inbound messages that fulfil a pending OTP. Now a missing or
  // malformed signature is rejected whenever a secret is set.
  // Signature verification is OPTIONAL — enforced only when a secret is
  // configured. When WHATSAPP_APP_SECRET IS set, the X-Hub-Signature-256 is
  // MANDATORY (a missing or bad one is rejected — SECURITY REVIEW H7). When it
  // is NOT set (e.g. this deployment doesn't use WhatsApp), verification is
  // skipped so the endpoint doesn't hard-fail; the org is still resolved from
  // the payload's phone_number_id below, and a message whose number maps to no
  // org is ignored — so an unconfigured deployment is not exposed.
  const appSecret = await getIntegration("WHATSAPP_APP_SECRET").catch(() => "");
  const sigHeader = req.headers.get("x-hub-signature-256") ?? "";
  if (appSecret) {
    if (!sigHeader.startsWith("sha256=")) return json({ error: "missing signature" }, 401);
    const expected = `sha256=${await hmacSha256Hex(appSecret, raw)}`;
    if (!constantTimeEq(expected, sigHeader)) {
      return json({ error: "bad signature" }, 401);
    }
  }

  let body: {
    entry?: Array<{
      changes?: Array<{
        value?: {
          metadata?: { phone_number_id?: string };
          messages?: Array<{ from?: string; type?: string; text?: { body?: string } }>;
        };
      }>;
    }>;
  };
  try { body = JSON.parse(raw); } catch { return json({ error: "invalid json" }, 400); }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const results: unknown[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // SECURITY REVIEW H1: resolve the tenant from the SIGNED payload's
      // phone_number_id — the org that owns the WhatsApp number the message
      // arrived on — NOT the unsigned `?org=` query param. The HMAC covers only
      // the body, so a valid signed payload could otherwise be replayed to
      // `?org=<victim>` to fulfil a victim org's pending OTP.
      const phoneId = (change.value?.metadata?.phone_number_id ?? "").trim();
      if (!phoneId) continue;
      const { data: chan } = await admin
        .from("org_otp_channels")
        .select("org_id")
        .eq("whatsapp_phone_id", phoneId)
        .maybeSingle();
      const resolvedOrg = (chan?.org_id as string | undefined) ?? "";
      if (!resolvedOrg) continue; // unknown number → not ours, ignore
      for (const msg of change.value?.messages ?? []) {
        if (msg.type !== "text") continue;
        const r = await ingestInbound({
          orgId: resolvedOrg,
          externalUserId: msg.from ?? null,           // E.164 without `+`
          channel: "whatsapp",
          messageText: msg.text?.body ?? "",
        });
        results.push(r);
      }
    }
  }
  return json({ ok: true, results }, 200);
});

async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  let h = "";
  for (const b of new Uint8Array(buf)) h += b.toString(16).padStart(2, "0");
  return h;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
