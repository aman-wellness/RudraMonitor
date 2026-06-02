// POST /functions/v1/org-otp-settings-save
// Headers: Authorization: Bearer <user JWT>   (must be org owner/admin)
//
// Upsert the caller's org_otp_settings row. Token-like fields go in as
// plaintext from the form and are encrypted server-side before insert.
// Sending `null` for a token field CLEARS it; omitting the field leaves
// the existing ciphertext untouched.
//
// Body keys (all optional except where noted by the UI):
//   {
//     teams_tenant_id, teams_channel_id, teams_bot_token,         // last is plaintext → encrypted
//     google_chat_webhook_url, google_chat_space_name,
//     slack_bot_token, slack_channel_id, slack_signing_secret,
//     whatsapp_provider, whatsapp_phone_id, whatsapp_token,
//     whatsapp_admin_numbers, whatsapp_template_name,
//     magic_link_base_url,
//     admin_links: [{ provider, external_id, display_name }]      // upserts org_otp_admin_links rows for caller
//   }

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { encrypt } from "../_shared/crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface Body {
  teams_tenant_id?: string | null;
  teams_team_id?: string | null;
  teams_channel_id?: string | null;
  teams_bot_token?: string | null;
  teams_webhook_url?: string | null;

  google_chat_webhook_url?: string | null;
  google_chat_space_name?: string | null;

  slack_bot_token?: string | null;
  slack_channel_id?: string | null;
  slack_signing_secret?: string | null;

  whatsapp_provider?: "meta_cloud" | "twilio" | null;
  whatsapp_phone_id?: string | null;
  whatsapp_token?: string | null;
  whatsapp_admin_numbers?: string[] | null;
  whatsapp_template_name?: string | null;

  magic_link_base_url?: string | null;

  // Per-channel enable toggles (migration 0099). When `false`, the channel
  // is skipped during OTP fan-out without forgetting the stored credentials —
  // flip back to `true` to resume without re-pasting tokens.
  slack_enabled?: boolean;
  teams_enabled?: boolean;
  google_chat_enabled?: boolean;
  whatsapp_enabled?: boolean;

  admin_links?: Array<{ provider: "teams" | "slack" | "google_chat" | "whatsapp"; external_id: string; display_name?: string }>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  // Caller must be owner or admin of an org. Pick the first membership.
  const { data: mem } = await admin.from("org_members")
    .select("org_id, role").eq("user_id", u.user.id).limit(1);
  if (!mem?.length) return json({ error: "no org for caller" }, 403);
  const orgId = mem[0].org_id as string;
  const role = mem[0].role as string;
  if (role !== "owner" && role !== "admin") {
    return json({ error: "owner or admin only" }, 403);
  }

  // Build the upsert row. Helper to encode each optional secret.
  const row: Record<string, unknown> = { org_id: orgId, updated_by: u.user.id };

  const setEnc = async (plain: string | null | undefined, key: string) => {
    if (plain === undefined) return;            // untouched
    if (plain === null || plain === "") { row[key] = null; return; }
    row[key] = await encrypt(plain, "CRED_VAULT_ENC_KEY");
  };

  try {
    if (body.teams_tenant_id !== undefined)         row.teams_tenant_id = body.teams_tenant_id || null;
    if (body.teams_team_id !== undefined)           row.teams_team_id = body.teams_team_id || null;
    if (body.teams_channel_id !== undefined)        row.teams_channel_id = body.teams_channel_id || null;
    await setEnc(body.teams_bot_token, "teams_bot_token_enc");
    await setEnc(body.teams_webhook_url, "teams_webhook_url_enc");

    await setEnc(body.google_chat_webhook_url, "google_chat_webhook_url_enc");
    if (body.google_chat_space_name !== undefined)  row.google_chat_space_name = body.google_chat_space_name || null;

    await setEnc(body.slack_bot_token, "slack_bot_token_enc");
    if (body.slack_channel_id !== undefined)        row.slack_channel_id = body.slack_channel_id || null;
    await setEnc(body.slack_signing_secret, "slack_signing_secret_enc");

    if (body.whatsapp_provider !== undefined)       row.whatsapp_provider = body.whatsapp_provider || null;
    if (body.whatsapp_phone_id !== undefined)       row.whatsapp_phone_id = body.whatsapp_phone_id || null;
    await setEnc(body.whatsapp_token, "whatsapp_token_enc");
    if (body.whatsapp_admin_numbers !== undefined)  row.whatsapp_admin_numbers = body.whatsapp_admin_numbers ?? [];
    if (body.whatsapp_template_name !== undefined)  row.whatsapp_template_name = body.whatsapp_template_name || null;

    if (body.magic_link_base_url !== undefined)     row.magic_link_base_url = body.magic_link_base_url || null;

    if (typeof body.slack_enabled === "boolean")       row.slack_enabled       = body.slack_enabled;
    if (typeof body.teams_enabled === "boolean")       row.teams_enabled       = body.teams_enabled;
    if (typeof body.google_chat_enabled === "boolean") row.google_chat_enabled = body.google_chat_enabled;
    if (typeof body.whatsapp_enabled === "boolean")    row.whatsapp_enabled    = body.whatsapp_enabled;
  } catch (e) {
    return json({ error: `encrypt: ${(e as Error).message}` }, 500);
  }

  const { error: upErr } = await admin
    .from("org_otp_settings")
    .upsert(row, { onConflict: "org_id" });
  if (upErr) return json({ error: `upsert: ${upErr.message}` }, 500);

  // Optional admin-link upserts for the caller. Each row maps a provider's
  // external user id to a Rudrans user, so inbound webhooks can attribute
  // replies. We restrict to upserting links for the *caller* — admins can
  // batch-add others via SQL if needed.
  if (Array.isArray(body.admin_links)) {
    for (const link of body.admin_links) {
      if (!link?.provider || !link?.external_id) continue;
      await admin.from("org_otp_admin_links").upsert({
        org_id: orgId,
        user_id: u.user.id,
        provider: link.provider,
        external_id: link.external_id,
        display_name: link.display_name ?? null,
      }, { onConflict: "org_id,provider,external_id" });
    }
  }

  return json({ ok: true }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
