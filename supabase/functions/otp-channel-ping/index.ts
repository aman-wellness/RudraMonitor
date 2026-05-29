// POST /functions/v1/otp-channel-ping
// Headers: Authorization: Bearer <user JWT>   (org member)
// Body:    { channel: 'teams' | 'slack' | 'google_chat' | 'whatsapp' }
//
// Sends a one-off test message through the channel adapter so the customer
// can verify the bot token / webhook URL / phone-number actually works
// before relying on it for real OTP delivery. Doesn't create an
// otp_requests row — the magic URL points to a static "test ping
// received" stub.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { dispatchChannel } from "../_shared/otp-channels.ts";
import { logEvent } from "../_shared/event-log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  let body: { channel?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const channel = (body.channel ?? "").trim();
  if (!["teams", "slack", "google_chat", "whatsapp"].includes(channel)) {
    return json({ error: "channel must be one of teams/slack/google_chat/whatsapp" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  const { data: mem } = await admin.from("org_members")
    .select("org_id").eq("user_id", u.user.id).limit(1).maybeSingle();
  if (!mem) return json({ error: "no org" }, 403);
  const orgId = mem.org_id as string;

  const r = await dispatchChannel(channel, {
    orgId,
    platform: "Rudrans test ping",
    prompt: `Hi! This is a connectivity test from your Auto-Invoice fetcher. If you see this message, ${channel} is wired up correctly. No action needed — reply ignored.`,
    magicUrl: `${SUPABASE_URL}/functions/v1/_pingreceived`,
    expiresMin: 5,
  });

  await logEvent({
    orgId,
    kind: r.ok ? "channel_ping_sent" : "channel_ping_failed",
    actor: `admin:${u.user.id}`,
    channel,
    message: r.ok ? `Test ping sent to ${channel}` : `Test ping to ${channel} failed: ${r.error}`,
    detail: { sent: r.sent, error: r.error },
  });

  return json({ ok: r.ok, error: r.error, sent: r.sent }, r.ok ? 200 : 502);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
