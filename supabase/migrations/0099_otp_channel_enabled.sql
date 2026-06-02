-- Per-channel "enabled" toggles + DB knobs for clean disconnect.
--
-- Until now an OTP channel was either "connected" (token + channel id
-- present) or "not connected" (token nulled). There was no middle state.
-- Customers asked for two new operations on the OTP Channels page:
--   • Disconnect — wipe the channel's stored credentials entirely.
--   • Disable    — keep credentials but skip this channel when fan-out
--                  fires (and hide it from "active channels" UI).
--
-- We add one boolean per channel. Default `true` so existing connections
-- keep working without explicit migration on the admin's side.

BEGIN;

ALTER TABLE public.org_otp_settings
  ADD COLUMN IF NOT EXISTS slack_enabled       boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS teams_enabled       boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS google_chat_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS whatsapp_enabled    boolean NOT NULL DEFAULT true;

-- Surface the flags through the safe view so the FE doesn't need to
-- separately query the base table (which doesn't have a SELECT policy
-- for non-service-role anyway).
DROP VIEW IF EXISTS public.org_otp_settings_safe;
CREATE VIEW public.org_otp_settings_safe AS
  SELECT org_id,
         (teams_admin_refresh_token_enc IS NOT NULL
          OR teams_webhook_url_enc IS NOT NULL
          OR teams_bot_token_enc IS NOT NULL
          OR teams_channel_id IS NOT NULL) AS teams_connected,
         (teams_webhook_url_enc IS NOT NULL)        AS teams_webhook_set,
         (teams_admin_refresh_token_enc IS NOT NULL) AS teams_delegated_set,
         teams_admin_email,
         teams_tenant_id, teams_team_id, teams_channel_id,
         teams_enabled,
         (google_chat_webhook_url_enc IS NOT NULL)  AS google_chat_connected,
         google_chat_space_name,
         google_chat_enabled,
         (slack_bot_token_enc IS NOT NULL)          AS slack_connected,
         slack_channel_id,
         slack_enabled,
         (whatsapp_token_enc IS NOT NULL)           AS whatsapp_connected,
         whatsapp_provider, whatsapp_phone_id, whatsapp_admin_numbers, whatsapp_template_name,
         whatsapp_enabled,
         magic_link_base_url,
         updated_at
    FROM public.org_otp_settings;
ALTER VIEW public.org_otp_settings_safe SET (security_invoker = true);
GRANT SELECT ON public.org_otp_settings_safe TO authenticated;

COMMIT;
