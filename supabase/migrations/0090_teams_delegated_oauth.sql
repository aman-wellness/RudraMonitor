-- 0090_teams_delegated_oauth.sql
-- Teams Incoming Webhook is retired (Dec 2025) and the Workflow template is
-- hidden in many tenants. The only path Microsoft still officially supports
-- for app-led posting into a channel is DELEGATED OAuth — a real user signs
-- in once, grants `ChannelMessage.Send` + `offline_access`, and we store
-- their refresh token. Subsequent posts mint a fresh access token and POST
-- to `/teams/{teamId}/channels/{channelId}/messages` on behalf of that user.
--
-- The post appears in Teams as "Posted by <that admin>" which is fine — it's
-- the customer's own admin, not us.
--
-- All token storage is encrypted with the same CRED_VAULT_ENC_KEY used for
-- credential passwords. The settings UI sees a boolean (`teams_delegated_set`),
-- never raw ciphertext.

alter table public.org_otp_settings
  add column if not exists teams_team_id                  text,
  add column if not exists teams_admin_email              text,
  add column if not exists teams_admin_refresh_token_enc  text;

drop view if exists public.org_otp_settings_safe;
create view public.org_otp_settings_safe as
  select org_id,
         (teams_admin_refresh_token_enc is not null
          or teams_webhook_url_enc is not null
          or teams_bot_token_enc is not null
          or teams_channel_id is not null) as teams_connected,
         (teams_webhook_url_enc is not null) as teams_webhook_set,
         (teams_admin_refresh_token_enc is not null) as teams_delegated_set,
         teams_admin_email,
         teams_tenant_id, teams_team_id, teams_channel_id,
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
