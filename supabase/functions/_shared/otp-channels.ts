// Shared outbound adapters for the four external OTP channels.
// invoice-otp-request fans out to whichever channels the credential has
// configured. Each adapter resolves the org's bot token / webhook URL from
// org_otp_settings, decrypts as needed, and POSTs the prompt + magic-link.
// All return { ok, error?, sent?:string[] } so the caller can record the
// per-channel outcome in otp_requests.channels_sent.
//
// Failure modes are isolated — if Teams is misconfigured but Slack works,
// the fan-out still succeeds via Slack. We never throw across the boundary.

import { adminClient } from "./crypto.ts";
import { decrypt } from "./crypto.ts";

export interface ChannelOutbound {
  orgId: string;
  platform: string;
  prompt: string;
  magicUrl: string;
  expiresMin: number;
}

export interface ChannelResult {
  ok: boolean;
  error?: string;
  sent?: string[];    // target identifiers actually reached (channel id, phone numbers, …)
}

// ── Teams ────────────────────────────────────────────────────────────────
//
// Uses the existing M365 OAuth app (DIRECTORY_M365_CLIENT_ID/SECRET from
// _shared/graph-email.ts). Posts an adaptive card to either a 1:1 chat or
// a channel thread, depending on which id the customer saved. Reply
// ingestion comes via a separate Graph change-notification subscription
// (otp-inbound-teams).

export async function sendTeams(o: ChannelOutbound): Promise<ChannelResult> {
  const admin = adminClient();
  const { data: s } = await admin.from("org_otp_settings")
    .select("teams_tenant_id, teams_team_id, teams_channel_id, teams_bot_token_enc, teams_webhook_url_enc, teams_admin_refresh_token_enc, teams_enabled")
    .eq("org_id", o.orgId).maybeSingle();

  if (s?.teams_enabled === false) return { ok: false, error: "teams disabled" };

  // ── Preferred path: delegated OAuth (refresh token from an admin who
  // signed in once). Works in every tenant that allows ChannelMessage.Send
  // — i.e. anywhere a normal user can post in the channel.
  if (s?.teams_admin_refresh_token_enc && s.teams_team_id && s.teams_channel_id) {
    try {
      const accessToken = await refreshDelegatedToken(s.teams_admin_refresh_token_enc, o.orgId);
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(s.teams_team_id)}/channels/${encodeURIComponent(s.teams_channel_id)}/messages`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            body: { contentType: "html", content: renderTeamsHtml(o) },
            importance: "high",
          }),
        },
      );
      if (!r.ok) return { ok: false, error: `teams (delegated): ${r.status} ${(await r.text()).slice(0, 200)}` };
      return { ok: true, sent: [s.teams_channel_id] };
    } catch (e) {
      return { ok: false, error: `teams (delegated): ${(e as Error).message}` };
    }
  }

  // Fallback path: Incoming Webhook (retired in most tenants).
  if (s?.teams_webhook_url_enc) {
    let url: string;
    try { url = await decrypt(s.teams_webhook_url_enc, "CRED_VAULT_ENC_KEY"); }
    catch (e) { return { ok: false, error: `teams webhook decrypt: ${(e as Error).message}` }; }

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildTeamsAdaptiveCard(o)),
    });
    if (!r.ok) return { ok: false, error: `teams webhook: ${r.status} ${(await r.text()).slice(0, 200)}` };
    return { ok: true, sent: ["teams-webhook"] };
  }

  // Fallback: Graph API (only works with RSC-consented app — see migration 0089).
  if (!s?.teams_tenant_id || !s?.teams_channel_id) {
    return { ok: false, error: "teams not configured (paste a webhook URL in OTP Channels)" };
  }

  const { getIntegrations } = await import("./integrations.ts");
  const cfg = await getIntegrations(["DIRECTORY_M365_CLIENT_ID", "DIRECTORY_M365_CLIENT_SECRET"]);
  if (!cfg.DIRECTORY_M365_CLIENT_ID || !cfg.DIRECTORY_M365_CLIENT_SECRET) {
    return { ok: false, error: "DIRECTORY_M365_CLIENT_ID/SECRET missing" };
  }

  // Acquire app token via client_credentials. (Bot-token in vault is for
  // future delegated-permission paths.)
  const tokenResp = await fetch(`https://login.microsoftonline.com/${s.teams_tenant_id}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.DIRECTORY_M365_CLIENT_ID,
      client_secret: cfg.DIRECTORY_M365_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!tokenResp.ok) return { ok: false, error: `teams token: ${await tokenResp.text()}` };
  const { access_token } = await tokenResp.json();

  // Channel ids look like "19:xxxx@thread.tacv2". For team-channels the
  // id has the form "<teamId>/channels/<channelId>" — we accept either.
  const channelPath = s.teams_channel_id.includes("/")
    ? `teams/${s.teams_channel_id}/messages`
    : `chats/${encodeURIComponent(s.teams_channel_id)}/messages`;

  const body = {
    body: { contentType: "html", content: renderTeamsHtml(o) },
    importance: "high",
  };
  const sendResp = await fetch(`https://graph.microsoft.com/v1.0/${channelPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!sendResp.ok) return { ok: false, error: `teams send: ${await sendResp.text()}` };
  void s.teams_bot_token_enc;
  return { ok: true, sent: [s.teams_channel_id] };
}

// ── Slack ────────────────────────────────────────────────────────────────
//
// Bot token (xoxb-…) posts a Block-Kit message. Reply ingestion happens at
// /functions/v1/otp-inbound-slack which verifies the signing secret.

export async function sendSlack(o: ChannelOutbound): Promise<ChannelResult> {
  const admin = adminClient();
  const { data: s } = await admin.from("org_otp_settings")
    .select("slack_bot_token_enc, slack_channel_id, slack_enabled")
    .eq("org_id", o.orgId).maybeSingle();
  if (!s?.slack_bot_token_enc || !s?.slack_channel_id) {
    return { ok: false, error: "slack not configured" };
  }
  // Disabled by the admin but credentials retained — skip fan-out, don't
  // count as a real failure. Flipping the toggle back to true resumes.
  if (s.slack_enabled === false) {
    return { ok: false, error: "slack disabled" };
  }
  let token: string;
  try { token = await decrypt(s.slack_bot_token_enc, "CRED_VAULT_ENC_KEY"); }
  catch (e) { return { ok: false, error: `slack token decrypt: ${(e as Error).message}` }; }

  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      channel: s.slack_channel_id,
      text: `OTP needed for ${o.platform}`,           // notification fallback
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `🔐 OTP needed: ${o.platform}` },
        },
        { type: "section", text: { type: "mrkdwn", text: `*${escape(o.prompt)}*\n\nReply with the 6-digit code, or use the button below.` } },
        {
          type: "actions",
          elements: [{
            type: "button",
            text: { type: "plain_text", text: "Open OTP form" },
            url: o.magicUrl,
            style: "primary",
          }],
        },
        { type: "context", elements: [{ type: "mrkdwn", text: `_Expires in ${o.expiresMin} min · single-use_` }] },
      ],
    }),
  });
  const j = await r.json() as { ok: boolean; error?: string; ts?: string };
  if (!j.ok) return { ok: false, error: `slack: ${j.error ?? "unknown"}` };
  return { ok: true, sent: [s.slack_channel_id] };
}

// ── Google Chat ──────────────────────────────────────────────────────────
//
// Incoming-webhook URL posts a card to the configured space. v1 = outbound
// only; admin replies via the magic-link button on the card. Upgrade to a
// Chat-app for inbound replies in a future phase.

export async function sendGChat(o: ChannelOutbound): Promise<ChannelResult> {
  const admin = adminClient();
  const { data: s } = await admin.from("org_otp_settings")
    .select("google_chat_webhook_url_enc, google_chat_enabled")
    .eq("org_id", o.orgId).maybeSingle();
  if (!s?.google_chat_webhook_url_enc) return { ok: false, error: "google chat not configured" };
  if (s.google_chat_enabled === false) return { ok: false, error: "google chat disabled" };

  let url: string;
  try { url = await decrypt(s.google_chat_webhook_url_enc, "CRED_VAULT_ENC_KEY"); }
  catch (e) { return { ok: false, error: `gchat url decrypt: ${(e as Error).message}` }; }

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cardsV2: [{
        cardId: `otp-${Date.now()}`,
        card: {
          header: { title: `OTP needed: ${o.platform}`, imageUrl: "https://www.gstatic.com/images/icons/material/system/2x/vpn_key_black_24dp.png", imageType: "CIRCLE" },
          sections: [
            { widgets: [{ textParagraph: { text: escape(o.prompt) } }] },
            {
              widgets: [{
                buttonList: {
                  buttons: [{
                    text: "Open OTP form",
                    onClick: { openLink: { url: o.magicUrl } },
                  }],
                },
              }],
            },
            { widgets: [{ textParagraph: { text: `<i>Expires in ${o.expiresMin} min · single-use</i>` } }] },
          ],
        },
      }],
    }),
  });
  if (!r.ok) return { ok: false, error: `gchat: ${r.status} ${await r.text()}` };
  return { ok: true, sent: ["gchat-space"] };
}

// ── WhatsApp (Meta Cloud API) ────────────────────────────────────────────
//
// Sends to each E.164 number in whatsapp_admin_numbers. Uses an approved
// template message (Meta blocks freeform messages to users who haven't
// opened a session in 24h). Customer registers the template once via
// Meta Business Manager — we just reference it by name.

export async function sendWhatsapp(o: ChannelOutbound): Promise<ChannelResult> {
  const admin = adminClient();
  const { data: s } = await admin.from("org_otp_settings")
    .select("whatsapp_provider, whatsapp_phone_id, whatsapp_token_enc, whatsapp_admin_numbers, whatsapp_template_name, whatsapp_enabled")
    .eq("org_id", o.orgId).maybeSingle();
  if (!s?.whatsapp_token_enc || !s?.whatsapp_admin_numbers?.length) {
    return { ok: false, error: "whatsapp not configured (token + numbers required)" };
  }
  if (s.whatsapp_enabled === false) return { ok: false, error: "whatsapp disabled" };
  if (s.whatsapp_provider !== "meta_cloud") {
    // Twilio path can be added later — Meta Cloud is the default we ship.
    return { ok: false, error: `whatsapp provider '${s.whatsapp_provider}' not implemented in Phase 3` };
  }
  if (!s.whatsapp_phone_id) return { ok: false, error: "whatsapp_phone_id missing" };

  let token: string;
  try { token = await decrypt(s.whatsapp_token_enc, "CRED_VAULT_ENC_KEY"); }
  catch (e) { return { ok: false, error: `wa token decrypt: ${(e as Error).message}` }; }

  const tpl = s.whatsapp_template_name || "rudrans_otp_prompt";
  const sentTo: string[] = [];
  const errors: string[] = [];

  for (const num of s.whatsapp_admin_numbers) {
    const r = await fetch(`https://graph.facebook.com/v20.0/${s.whatsapp_phone_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: num,
        type: "template",
        template: {
          name: tpl,
          language: { code: "en" },
          components: [{
            type: "body",
            parameters: [
              { type: "text", text: o.platform },
              { type: "text", text: o.prompt },
              { type: "text", text: o.magicUrl },
              { type: "text", text: String(o.expiresMin) },
            ],
          }],
        },
      }),
    });
    if (r.ok) sentTo.push(num);
    else errors.push(`${num}: ${r.status}`);
  }
  if (sentTo.length === 0) return { ok: false, error: `wa: ${errors.join("; ")}` };
  return { ok: true, sent: sentTo, error: errors.length ? errors.join("; ") : undefined };
}

// ── Helper to dispatch by channel name ───────────────────────────────────
export async function dispatchChannel(channel: string, o: ChannelOutbound): Promise<ChannelResult> {
  switch (channel) {
    case "teams":       return sendTeams(o);
    case "slack":       return sendSlack(o);
    case "google_chat": return sendGChat(o);
    case "whatsapp":    return sendWhatsapp(o);
    default:            return { ok: false, error: `unknown channel: ${channel}` };
  }
}

// Exchange the encrypted refresh token for a fresh access token. We don't
// bother caching the access_token between calls — they're short-lived
// (~60 min) and OTP requests are rare enough that one token mint per call
// is fine.
async function refreshDelegatedToken(refreshTokenEnc: string, _orgId: string): Promise<string> {
  const refresh = await decrypt(refreshTokenEnc, "CRED_VAULT_ENC_KEY");
  const { getIntegrations } = await import("./integrations.ts");
  const cfg = await getIntegrations(["DIRECTORY_M365_CLIENT_ID", "DIRECTORY_M365_CLIENT_SECRET"]);
  if (!cfg.DIRECTORY_M365_CLIENT_ID || !cfg.DIRECTORY_M365_CLIENT_SECRET) {
    throw new Error("DIRECTORY_M365_CLIENT_ID/SECRET missing");
  }
  const r = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.DIRECTORY_M365_CLIENT_ID,
      client_secret: cfg.DIRECTORY_M365_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope: "offline_access ChannelMessage.Send Team.ReadBasic.All Channel.ReadBasic.All",
    }),
  });
  if (!r.ok) throw new Error(`refresh: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json() as { access_token: string; refresh_token?: string };
  // Microsoft rotates refresh tokens — persist the new one if returned.
  if (j.refresh_token) {
    try {
      const { encrypt } = await import("./crypto.ts");
      const newEnc = await encrypt(j.refresh_token, "CRED_VAULT_ENC_KEY");
      await adminClient().from("org_otp_settings")
        .update({ teams_admin_refresh_token_enc: newEnc })
        .eq("teams_admin_refresh_token_enc", refreshTokenEnc);
    } catch { /* non-fatal */ }
  }
  return j.access_token;
}

function renderTeamsHtml(o: ChannelOutbound): string {
  return `
    <p><strong>OTP needed: ${escape(o.platform)}</strong></p>
    <p>${escape(o.prompt)}</p>
    <p><a href="${escape(o.magicUrl)}">Open OTP form</a></p>
    <p><i>Expires in ${o.expiresMin} min · single-use</i></p>`;
}

// Adaptive Card payload for Teams Incoming Webhook (Workflow connector).
// Schema docs: https://adaptivecards.io/explorer/
function buildTeamsAdaptiveCard(o: ChannelOutbound): Record<string, unknown> {
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", size: "Medium", weight: "Bolder", text: `🔐 OTP needed: ${o.platform}` },
          { type: "TextBlock", text: o.prompt, wrap: true },
          { type: "TextBlock", text: `Expires in ${o.expiresMin} min · single-use`, isSubtle: true, size: "Small" },
        ],
        actions: [
          { type: "Action.OpenUrl", title: "Open OTP form", url: o.magicUrl },
        ],
      },
    }],
  };
}

function escape(s: string | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  } as Record<string, string>)[c]);
}
