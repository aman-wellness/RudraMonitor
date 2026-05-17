-- 0044_billing_sync_meta.sql
-- Per-credential metadata for billing-API auto-sync. The actual API token
-- lives in credentials.billing_api_token_enc (already exists). These columns
-- track when the last pull happened + whether it failed so the UI can show
-- a "last sync" badge and surface errors inline.

alter table public.credentials
  add column if not exists billing_api_last_synced_at timestamptz,
  add column if not exists billing_api_last_sync_error text,
  add column if not exists billing_api_meta jsonb not null default '{}'::jsonb;

-- Refresh the safe view so the UI can read these without seeing the token.
drop view if exists public.credentials_safe;
create view public.credentials_safe as
  select id, org_id, platform_name, category, login_url, username, notes,
         owner_dept_id, tags, is_shared_account, active,
         billing_cycle, price_amount, price_currency, seats_total,
         subscription_starts_at, subscription_ends_at,
         subscription_model, billing_api_provider,
         billing_api_last_synced_at, billing_api_last_sync_error,
         (billing_api_token_enc is not null) as billing_api_connected,
         created_by, created_at, updated_at, last_rotated_at
    from public.credentials;
