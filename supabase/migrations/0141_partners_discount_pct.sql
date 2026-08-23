-- 0141_partners_discount_pct.sql
--
-- FIX (audit H12).
--
-- The partner admin UI reads and writes `partners.discount_pct` (the discount
-- applied to a partner-routed customer's price — distinct from `commission_pct`,
-- which is what the partner earns), and NewCustomerModal reads it to price new
-- quotes. But the column was never created. Consequences:
--   • Saving a partner sends `discount_pct` in the UPDATE → Postgres rejects the
--     whole update → partner edits silently fail.
--   • NewCustomerModal's `.select('discount_pct')` 400s → falls back to a
--     hard-coded 40%, so every partner-routed quote used 40% regardless of the
--     intended rate.
--
-- Default 40.00 matches the app's existing fallback so behaviour is unchanged
-- for rows that predate this column.

alter table public.partners
  add column if not exists discount_pct numeric(5,2) not null default 40.00;

alter table public.partners
  drop constraint if exists partners_discount_pct_check;
alter table public.partners
  add constraint partners_discount_pct_check
  check (discount_pct >= 0 and discount_pct <= 90) not valid;

comment on column public.partners.discount_pct is
  'Discount % applied to a partner-routed customer''s price. Distinct from commission_pct (what the partner earns).';
