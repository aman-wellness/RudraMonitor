-- 0059_credentials_passwordless.sql
-- Many platforms (Slack, Notion, Linear, GitHub with SSO, etc.) are OTP /
-- magic-link / SSO based and have no shared password to store in the vault.
-- Customers were forced to enter a fake password just to save the row.
--
-- This migration:
--   • Adds `is_passwordless boolean` on credentials so the UI can render a
--     "Login via OTP" badge instead of an empty password field.
--   • Drops the implicit NOT NULL on password_enc (it was already nullable —
--     this just documents intent).
--   • Backfills `is_passwordless = false` for every existing row so old data
--     keeps behaving the same.

alter table public.credentials
  add column if not exists is_passwordless boolean not null default false;

comment on column public.credentials.is_passwordless is
  'True when the platform uses OTP / magic-link / SSO and there is no shared password to dispatch. The "Send to user" flow then sends the login URL only.';
