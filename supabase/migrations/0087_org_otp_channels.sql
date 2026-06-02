-- 0087_org_otp_channels.sql
-- Phase-3 of the auto-invoice fetcher. Adds two tables:
--
--   • org_otp_settings    — one row per org. Holds the encrypted bot
--                           tokens / webhook URLs for the four external
--                           channels (Teams, Slack, Google Chat, WhatsApp).
--                           Customer connects each channel once from the
--                           OTP Channels settings page.
--
--   • org_otp_admin_links — maps an external user identifier (Slack
--                           member_id, Teams AAD oid, WA phone number,
--                           Google Chat user-id) back to a Rudrans
--                           auth.users.id. Used by the inbound-webhook
--                           edge fns to attribute "who replied with the
--                           code". Without a link the reply still works
--                           but `responded_by` stays NULL.
--
-- All bot tokens / webhook URLs are encrypted at rest with the same
-- CRED_VAULT_ENC_KEY used for credential passwords; decryption only
-- happens inside the channel adapter edge fns at send time.

create table if not exists public.org_otp_settings (
  org_id                       uuid primary key references public.organizations(id) on delete cascade,

  -- Microsoft Teams: bot uses the existing M365 OAuth (graph-email.ts pattern).
  -- channel_id is the Graph `chats/{id}` or `teams/{id}/channels/{id}` resource id.
  teams_tenant_id              text,
  teams_channel_id             text,
  teams_bot_token_enc          text,                 -- base64 pgp; optional (Graph cert auth is fine too)

  -- Google Chat: simplest path is an incoming webhook URL on a "Rudrans-OTP" space.
  -- Bidirectional (admin replies) requires a Chat-app; Phase-3 ships webhook-only
  -- for outbound, admin uses magic-link to reply.
  google_chat_webhook_url_enc  text,
  google_chat_space_name       text,                 -- spaces/XXXX — used when we upgrade to a Chat-app

  -- Slack: Bot token (xoxb-…) + channel id. Inbound replies go to
  -- otp-inbound-slack with the standard Slack signing-secret verification.
  slack_bot_token_enc          text,
  slack_channel_id             text,
  slack_signing_secret_enc     text,                 -- per-app secret used to verify webhook signatures

  -- WhatsApp Business: either Meta Cloud API (preferred) or Twilio.
  whatsapp_provider            text check (whatsapp_provider in ('meta_cloud','twilio')),
  whatsapp_phone_id            text,                 -- Meta: phone_number_id from the Cloud Console
  whatsapp_token_enc           text,                 -- Meta: long-lived access token, Twilio: account_sid:auth_token JSON
  whatsapp_admin_numbers       text[] not null default array[]::text[],   -- E.164 list
  whatsapp_template_name       text,                 -- approved Meta template for OTP prompts

  magic_link_base_url          text,                 -- override; defaults to https://ems.wellnessextract.com

  updated_at                   timestamptz not null default now(),
  updated_by                   uuid references auth.users(id) on delete set null
);

create or replace function public.touch_org_otp_settings_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_org_otp_settings_touch on public.org_otp_settings;
create trigger trg_org_otp_settings_touch before update on public.org_otp_settings
  for each row execute function public.touch_org_otp_settings_updated_at();

alter table public.org_otp_settings enable row level security;

-- Org members can see WHICH channels are connected (booleans) via the safe
-- view below — never the raw tokens. Writes only via the edge fn.
drop policy if exists org_otp_settings_select on public.org_otp_settings;
create policy org_otp_settings_select on public.org_otp_settings
  for select using (org_id in (select public.user_org_ids()));

-- Safe view: surface booleans + non-secret fields so the settings UI can
-- render "Connected" / "Not connected" badges without ever exposing
-- ciphertext to the browser.
create or replace view public.org_otp_settings_safe as
  select org_id,
         (teams_bot_token_enc is not null or teams_channel_id is not null) as teams_connected,
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

-- ── org_otp_admin_links ──────────────────────────────────────────────────
-- One row per (org, provider, external_id). Lets inbound webhooks
-- attribute a reply to a Rudrans user even if the dashboard isn't open.
create table if not exists public.org_otp_admin_links (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider      text not null check (provider in ('teams','slack','google_chat','whatsapp')),
  external_id   text not null,                       -- Slack member_id, Teams AAD oid, WA phone (E.164), GChat users/XXXX
  display_name  text,                                -- best-effort label for the settings UI
  created_at    timestamptz not null default now()
);

create unique index if not exists org_otp_admin_links_unique
  on public.org_otp_admin_links(org_id, provider, external_id);
create index if not exists org_otp_admin_links_user_idx on public.org_otp_admin_links(user_id);

alter table public.org_otp_admin_links enable row level security;

drop policy if exists org_otp_admin_links_select on public.org_otp_admin_links;
create policy org_otp_admin_links_select on public.org_otp_admin_links
  for select using (org_id in (select public.user_org_ids()));

-- Writes only via service role (the inbound webhooks insert/update). The
-- settings UI lets admins create a link by entering their Slack member id /
-- WA number directly through the org-otp-settings-save edge fn.
