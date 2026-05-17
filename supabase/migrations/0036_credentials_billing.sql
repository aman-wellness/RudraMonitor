-- 0036_credentials_billing.sql
-- Add subscription / pricing metadata to the credentials vault so admins can
-- track per-tool spend alongside the access controls. None of this is secret,
-- so it lives on the existing `credentials` table and is mirrored into the
-- `credentials_safe` view.

alter table public.credentials
  add column if not exists billing_cycle         text,
  add column if not exists price_amount          numeric(12, 2),
  add column if not exists price_currency        text,
  add column if not exists seats_total           int,
  add column if not exists subscription_starts_at date,
  add column if not exists subscription_ends_at   date;

-- A loose check constraint — keeps free-text safe but signals canonical values.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'credentials_billing_cycle_check'
  ) then
    alter table public.credentials
      add constraint credentials_billing_cycle_check
      check (billing_cycle is null or billing_cycle in ('monthly','quarterly','yearly','one_time','custom'));
  end if;
end$$;

-- Rebuild the safe view with the new columns so the vault list page can read
-- them without seeing password_enc. Postgres rejects CREATE OR REPLACE when
-- the column list changes shape, so DROP first.
drop view if exists public.credentials_safe;
create view public.credentials_safe as
  select id, org_id, platform_name, category, login_url, username, notes,
         owner_dept_id, tags, is_shared_account, active,
         billing_cycle, price_amount, price_currency, seats_total,
         subscription_starts_at, subscription_ends_at,
         created_by, created_at, updated_at, last_rotated_at
    from public.credentials;

-- Convenience view: "who has access to what" — one row per (credential, employee)
-- with display fields for the access-map page.
create or replace view public.v_credential_access as
  select
    a.org_id,
    c.id           as credential_id,
    c.platform_name,
    c.category,
    c.billing_cycle,
    c.price_amount,
    c.price_currency,
    c.active,
    a.id           as assignment_id,
    a.employee_id,
    coalesce(e.full_name, a.delivery_email) as user_name,
    a.delivery_email,
    a.sent_at,
    a.sent_by,
    a.revoked_at
  from public.credential_assignments a
  join public.credentials c on c.id = a.credential_id
  left join public.employees e on e.id = a.employee_id;
