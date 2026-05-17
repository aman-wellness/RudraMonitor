-- 0045_employee_management_plan.sql
-- Bring the Employee Management module into the subscription model:
--   • A new standalone plan ("Employee Management Unlimited", $100/mo) for
--     customers that only want EM and don't need the agent/monitoring stack.
--   • An add-on price on every existing plan so customers who already have
--     a plan can layer EM on top for the same $100/mo.
--   • Per-org flags that determine whether EM features are visible.
--
-- Feature gating works against `organizations.em_active`:
--   true during the org's active trial (so new signups can try EM)
--   true if em_subscribed = true (paid)
--   false otherwise → /employees/* routes show a paywall card.
--
-- Razorpay integration for actual upgrades/downgrades comes in a follow-up;
-- for now the toggle is admin-only (no money moves until that's wired).

-- ============== plans extensions ==============
alter table public.plans
  add column if not exists em_addon_price_usd numeric(10,2) not null default 100.00,
  add column if not exists em_addon_price_inr numeric(10,2) not null default 8500.00,
  add column if not exists is_em_standalone boolean not null default false,
  add column if not exists price_usd numeric(10,2);

comment on column public.plans.em_addon_price_usd is
  'Add-on price (USD) for the Employee Management module on top of this plan.';
comment on column public.plans.is_em_standalone is
  'True for plans that bundle Employee Management (no separate add-on needed).';

-- Seed the standalone EM plan. Idempotent on code.
insert into public.plans (code, name, description, seat_count, price_inr, partner_price_inr, price_usd, billing_cycle, is_active, is_em_standalone, em_addon_price_usd, em_addon_price_inr)
values
  ('em-unlimited', 'Employee Management Unlimited',
   'Full lifecycle suite: provisioning, M365 & Google sync, groups & teams, credentials vault, IT hardware, managers, offboarding. Unlimited users.',
   9999, 8500, 6500, 100, 'monthly', true, true, 0, 0)
on conflict (code) do nothing;

-- ============== organizations extensions ==============
alter table public.organizations
  add column if not exists em_subscribed boolean not null default false,
  add column if not exists em_subscribed_since timestamptz,
  add column if not exists em_addon_invoice_id text;

-- Generated column: EM is "active" if the org is in trial OR has paid for it.
-- We use a function + computed view rather than a stored-generated column so
-- the trial-vs-now check stays current.
create or replace view public.organizations_with_features as
  select o.*,
         (o.em_subscribed
            or (o.subscription_status = 'trial' and o.trial_ends_at > now())) as em_active
    from public.organizations o;

-- Helper for RLS-friendly reads from the UI.
create or replace function public.org_em_active(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    o.em_subscribed
      or (o.subscription_status = 'trial' and o.trial_ends_at > now())
  from public.organizations o
  where o.id = p_org
$$;
