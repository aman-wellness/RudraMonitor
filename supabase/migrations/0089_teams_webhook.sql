-- 0089_teams_webhook.sql
-- The Graph-API path for Teams (tenant_id + channel_id + app-only auth)
-- requires either `Teamwork.Migrate.All` (Microsoft-gated) or a
-- resource-specific-consent flow with a sideloaded Teams app — both are
-- heavy lifts most customers won't do. Instead, prefer the much simpler
-- Incoming Webhook flow: customer creates a "Workflow" / "Incoming
-- Webhook" connector in their channel and pastes the URL into our
-- settings. We POST an Adaptive Card to it. No OAuth, no admin consent.
--
-- We keep the Graph fields around so the inbound (replies) path still
-- works for orgs that have wired that up — outbound just prefers the
-- webhook when present.

alter table public.org_otp_settings
  add column if not exists teams_webhook_url_enc text;

-- Rebuild safe view so the OTP settings UI can render
-- "Connected via webhook" / "Connected via Graph" without seeing
-- ciphertext.
drop view if exists public.org_otp_settings_safe;
create view public.org_otp_settings_safe as
  select org_id,
         (teams_webhook_url_enc is not null or teams_bot_token_enc is not null or teams_channel_id is not null) as teams_connected,
         (teams_webhook_url_enc is not null) as teams_webhook_set,
         teams_tenant_id, teams_channel_id,
         (google_chat_webhook_url_enc is not null) as google_chat_connected,
         google_chat_space_name,
         (slack_bot_token_enc is not null) as slack_connected,
         slack_channel_id,
         (whatsapp_token_enc is not null) as whatsapp_connected,
         whatsapp_provider, whatsapp_phone_id, whatsapp_admin_numbers, whatsapp_template_name,
         magic_link_base_url,
         updated_at
    from public.org_otp_settings;
alter view public.org_otp_settings_safe set (security_invoker = true);
grant select on public.org_otp_settings_safe to authenticated;
