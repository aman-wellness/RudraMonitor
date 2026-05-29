// POST /functions/v1/otp-inbound-teams?org=<org_id>
//
// Microsoft Graph change-notification webhook for new chat messages in
// the OTP channel. Two phases:
//
//   1. Subscription validation: Graph sends a GET (or POST with
//      `validationToken` query param) — we echo the token back as
//      text/plain within 10 seconds. Required ONCE when the subscription
//      is created via /subscriptions API.
//
//   2. Notification payload: Graph POSTs a body containing the resource
//      URL of the new message. We fetch the message, parse the OTP digits,
//      and call ingestInbound().
//
// The Graph subscription itself is created by an admin operator via a
// one-time script (not shipped here) — Phase-3 ships the receiver only.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { ingestInbound } from "../_shared/otp-inbound.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const orgId = (url.searchParams.get("org") ?? "").trim();
  if (!orgId) return new Response("missing ?org=<uuid>", { status: 400 });

  // ── Subscription validation ────────────────────────────────────────────
  // Graph sends ?validationToken=<token> when creating the subscription;
  // we must return it as text/plain unchanged within 10 s.
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new Response(validationToken, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  let payload: { value?: Array<{ resource?: string; resourceData?: { id?: string }; clientState?: string }> };
  try { payload = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: cfg } = await admin
    .from("org_otp_settings")
    .select("teams_tenant_id, teams_channel_id")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!cfg?.teams_tenant_id) return json({ error: "teams not configured for org" }, 404);

  const g = await getIntegrations(["DIRECTORY_M365_CLIENT_ID", "DIRECTORY_M365_CLIENT_SECRET"]);
  if (!g.DIRECTORY_M365_CLIENT_ID || !g.DIRECTORY_M365_CLIENT_SECRET) {
    return json({ error: "DIRECTORY_M365_CLIENT_ID/SECRET missing" }, 500);
  }
  const tokenResp = await fetch(`https://login.microsoftonline.com/${cfg.teams_tenant_id}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: g.DIRECTORY_M365_CLIENT_ID,
      client_secret: g.DIRECTORY_M365_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!tokenResp.ok) return json({ error: `token: ${await tokenResp.text()}` }, 502);
  const { access_token } = await tokenResp.json();

  const results: unknown[] = [];
  for (const notif of payload.value ?? []) {
    if (!notif.resource) continue;
    const msgResp = await fetch(`https://graph.microsoft.com/v1.0/${notif.resource}`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!msgResp.ok) { results.push({ skipped: msgResp.status }); continue; }
    const msg = await msgResp.json() as {
      from?: { user?: { id?: string; displayName?: string } };
      body?: { content?: string };
    };
    // Strip HTML — Graph returns rich text.
    const text = (msg.body?.content ?? "").replace(/<[^>]+>/g, " ");
    const r = await ingestInbound({
      orgId,
      externalUserId: msg.from?.user?.id ?? null,
      channel: "teams",
      messageText: text,
    });
    results.push(r);
  }
  return json({ ok: true, results }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
