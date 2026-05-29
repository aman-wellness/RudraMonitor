// POST /functions/v1/otp-inbound-slack
//
// Slack Events API receiver. Configure the Slack app's Event Subscriptions
// to point here and subscribe to the `message.channels` event (and
// `message.im` if you want DM replies to work too).
//
// We verify the signature using the per-org slack_signing_secret stored in
// org_otp_settings.slack_signing_secret_enc. The webhook URL must include
// `?org=<org_id>` so we know which secret to load — single global app
// installed per org works the same as a multi-tenant app.
//
// Slack URL verification challenge is supported (no signature needed).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { decrypt } from "../_shared/crypto.ts";
import { ingestInbound } from "../_shared/otp-inbound.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  const orgId = (url.searchParams.get("org") ?? "").trim();
  if (!orgId) return json({ error: "missing ?org=<uuid>" }, 400);

  const raw = await req.text();

  // URL-verification handshake: { type: "url_verification", challenge: "..." }
  try {
    const probe = JSON.parse(raw);
    if (probe.type === "url_verification" && typeof probe.challenge === "string") {
      return new Response(probe.challenge, { headers: { "Content-Type": "text/plain" } });
    }
  } catch { /* not JSON — fall through */ }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: cfg } = await admin
    .from("org_otp_settings")
    .select("slack_signing_secret_enc, slack_channel_id")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!cfg?.slack_signing_secret_enc) return json({ error: "slack not configured for org" }, 404);

  let signingSecret: string;
  try { signingSecret = await decrypt(cfg.slack_signing_secret_enc, "CRED_VAULT_ENC_KEY"); }
  catch (e) { return json({ error: `decrypt: ${(e as Error).message}` }, 500); }

  // Slack signature verification.
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || !sig) return json({ error: "missing slack signature headers" }, 401);
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return json({ error: "stale request" }, 401);

  const baseString = `v0:${ts}:${raw}`;
  const expected = `v0=${await hmacSha256Hex(signingSecret, baseString)}`;
  if (!constantTimeEq(expected, sig)) return json({ error: "bad signature" }, 401);

  // Parse the event.
  const body = JSON.parse(raw) as {
    event?: { type?: string; subtype?: string; text?: string; user?: string; channel?: string; bot_id?: string };
  };
  const ev = body.event;
  if (!ev || ev.type !== "message" || ev.subtype || ev.bot_id) {
    return json({ ok: true, ignored: "non-user message" }, 200);
  }

  // Optionally restrict to the configured channel.
  if (cfg.slack_channel_id && ev.channel && cfg.slack_channel_id !== ev.channel) {
    return json({ ok: true, ignored: "other channel" }, 200);
  }

  const result = await ingestInbound({
    orgId,
    externalUserId: ev.user ?? null,
    channel: "slack",
    messageText: ev.text ?? "",
  });
  return json(result, result.ok ? 200 : 202);
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
