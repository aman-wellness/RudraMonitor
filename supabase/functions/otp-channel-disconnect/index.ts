// POST /functions/v1/otp-channel-disconnect
// Headers: Authorization: Bearer <user JWT>
// Body:    { channel: 'slack' | 'teams' | 'google_chat' | 'whatsapp' }
//
// Wipes the stored credentials for ONE OTP channel — sets every
// channel-specific column to NULL (encrypted tokens, IDs, signing secrets,
// admin lists, etc.). The org_otp_settings row stays so the org's other
// channels keep working; only the named channel is cleared.
//
// "Disable without forgetting tokens" is a separate operation handled by
// org-otp-settings-save with {<channel>_enabled: false}. This function is
// the hard delete — used when the customer wants to remove the integration
// entirely (e.g. they're switching from Slack to Teams).
//
// Auth: caller must be an owner / admin of the org.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Per-channel: list of columns to NULL when disconnecting. The view's
// `<channel>_connected` flag depends on the first column in each list, so
// nulling that flips the badge to "Not connected" in the UI.
const CHANNEL_COLUMNS: Record<string, string[]> = {
  slack: [
    "slack_bot_token_enc",
    "slack_channel_id",
    "slack_signing_secret_enc",
  ],
  teams: [
    "teams_bot_token_enc",
    "teams_webhook_url_enc",
    "teams_admin_refresh_token_enc",
    "teams_admin_email",
    "teams_tenant_id",
    "teams_team_id",
    "teams_channel_id",
  ],
  google_chat: [
    "google_chat_webhook_url_enc",
    "google_chat_space_name",
  ],
  whatsapp: [
    "whatsapp_token_enc",
    "whatsapp_provider",
    "whatsapp_phone_id",
    "whatsapp_template_name",
    "whatsapp_admin_numbers",     // array — set to {} (empty)
  ],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = bearer(req);
  if (!jwt) return json({ error: "missing user token" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);
  const callerId = u.user.id;

  let body: { channel?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const channel = body.channel;
  if (!channel || !CHANNEL_COLUMNS[channel]) {
    return json({ error: "channel must be one of: slack, teams, google_chat, whatsapp" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Find the org the caller is owner/admin of.
  const { data: writer } = await admin
    .from("org_members")
    .select("org_id, role")
    .eq("user_id", callerId)
    .in("role", ["owner", "admin"])
    .limit(1).maybeSingle();
  let orgId: string | null = (writer as { org_id: string } | null)?.org_id ?? null;
  if (!orgId) {
    const { data: owned } = await admin.from("organizations").select("id").eq("owner_user_id", callerId).limit(1);
    orgId = (owned?.[0] as { id: string } | undefined)?.id ?? null;
  }
  if (!orgId) return json({ error: "only an owner / admin of the org can disconnect a channel" }, 403);

  // Build a patch that nulls every column for the named channel. Array
  // columns (whatsapp_admin_numbers) need an empty array, not NULL — the
  // column is NOT NULL with a default.
  const patch: Record<string, unknown> = {};
  for (const col of CHANNEL_COLUMNS[channel]) {
    patch[col] = col === "whatsapp_admin_numbers" ? [] : null;
  }
  // Also clear the enabled flag so a future reconnect starts clean.
  patch[`${channel}_enabled`] = true;

  const { error } = await admin
    .from("org_otp_settings")
    .update(patch)
    .eq("org_id", orgId);
  if (error) return json({ error: error.message }, 500);

  // Also drop any admin-links for this channel (Slack member ids etc.) —
  // they're no longer meaningful once the channel is gone.
  await admin
    .from("org_otp_admin_links")
    .delete()
    .eq("org_id", orgId)
    .eq("provider", channel);

  return json({ ok: true, channel, org_id: orgId }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
