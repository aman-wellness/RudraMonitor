-- New per-seat plan structure introduced 2026-05-24.
--
-- Plan families:
--   monitoring          — Starter, Professional (per-seat)
--   employee_management — standalone EM subscription (per-seat, capped at
--                         2000 users; >2000 requires Enterprise)
--   addon               — DLP add-on, EM add-on (per-seat; layered onto a
--                         base monitoring plan)
--
-- Pricing model:
--   - All new plans are PER-SEAT: `price_inr` / `price_usd` is the unit
--     price per seat per billing cycle.
--   - Customer picks seat count at checkout; total = seats × unit price.
--   - License seat count = purchased seat count; license_count column on
--     organizations is bumped to the purchased value on subscription.
--
-- Legacy plans (`scale-100`, `growth-25`, `starter-5`, `em-unlimited`,
-- `Starter-monthly`) stay UNCHANGED — existing customers continue on
-- those rows. Only new signups land on the v2 plans below.

BEGIN;

-- 1. Schema: distinguish plan families + mark add-ons.
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS family text
    CHECK (family IN ('monitoring','employee_management','addon')),
  ADD COLUMN IF NOT EXISTS is_addon boolean NOT NULL DEFAULT false;

-- Legacy rows: backfill family for clarity (only affects admin UI listings).
UPDATE public.plans
   SET family = CASE
     WHEN is_em_standalone THEN 'employee_management'
     ELSE 'monitoring'
   END
 WHERE family IS NULL;

-- 2. Seed v2 plans. We use new codes so they coexist with legacy SKUs.
--    `features_included` uses the v2 canonical feature codes that the
--    dashboard's useFeatures hook will read.

-- Starter (monitoring basic only)
INSERT INTO public.plans (
  code, name, description,
  seat_count, billing_cycle, family, is_active,
  price_inr, price_usd, partner_price_inr,
  features_included, is_em_standalone,
  em_addon_price_inr, em_addon_price_usd, dlp_addon_price_inr
) VALUES
('starter-m', 'Starter', 'Basic activity monitoring per seat — applications, browser, idle time.',
  1, 'monthly', 'monitoring', true,
  299.00, 4.00, 209.30,
  ARRAY['monitoring_basic']::text[], false,
  499.00, 7.00, 199.00),
('starter-y', 'Starter', 'Basic activity monitoring per seat (yearly, save ~16%).',
  1, 'yearly', 'monitoring', true,
  2999.00, 40.00, 2099.30,
  ARRAY['monitoring_basic']::text[], false,
  4999.00, 67.00, 1999.00)
ON CONFLICT (code) DO NOTHING;

-- Professional (full monitoring + DLP + screenshots/videos + live + remote)
INSERT INTO public.plans (
  code, name, description,
  seat_count, billing_cycle, family, is_active,
  price_inr, price_usd, partner_price_inr,
  features_included, is_em_standalone,
  em_addon_price_inr, em_addon_price_usd, dlp_addon_price_inr
) VALUES
('pro-m', 'Professional', 'Full monitoring per seat — screenshots, videos, live, remote desktop, DLP.',
  1, 'monthly', 'monitoring', true,
  899.00, 12.00, 629.30,
  ARRAY['monitoring_basic','screenshots','videos','live','remote','dlp']::text[], false,
  499.00, 7.00, 0.00),
('pro-y', 'Professional', 'Full monitoring per seat (yearly, save ~16%).',
  1, 'yearly', 'monitoring', true,
  8999.00, 120.00, 6299.30,
  ARRAY['monitoring_basic','screenshots','videos','live','remote','dlp']::text[], false,
  4999.00, 67.00, 0.00)
ON CONFLICT (code) DO NOTHING;

-- Employee Management standalone (no monitoring; up to 2000 users)
INSERT INTO public.plans (
  code, name, description,
  seat_count, billing_cycle, family, is_active,
  price_inr, price_usd, partner_price_inr,
  features_included, is_em_standalone,
  em_addon_price_inr, em_addon_price_usd, dlp_addon_price_inr
) VALUES
('em-m', 'Employee Management', 'Per-seat EM suite — provisioning, M365/Google sync, credentials vault, hardware, offboarding. Up to 2000 users.',
  1, 'monthly', 'employee_management', true,
  499.00, 7.00, 349.30,
  ARRAY['employee_management']::text[], true,
  0.00, 0.00, 0.00),
('em-y', 'Employee Management', 'Per-seat EM suite (yearly, save ~16%). Up to 2000 users.',
  1, 'yearly', 'employee_management', true,
  4999.00, 67.00, 3499.30,
  ARRAY['employee_management']::text[], true,
  0.00, 0.00, 0.00)
ON CONFLICT (code) DO NOTHING;

-- DLP add-on (per-seat, layered onto Starter)
INSERT INTO public.plans (
  code, name, description,
  seat_count, billing_cycle, family, is_active, is_addon,
  price_inr, price_usd, partner_price_inr,
  features_included, is_em_standalone,
  em_addon_price_inr, em_addon_price_usd, dlp_addon_price_inr
) VALUES
('dlp-addon-m', 'DLP Add-on', 'Per-seat data-loss-prevention add-on. Stack onto any plan.',
  1, 'monthly', 'addon', true, true,
  199.00, 3.00, 139.30,
  ARRAY['dlp']::text[], false,
  0.00, 0.00, 0.00),
('dlp-addon-y', 'DLP Add-on', 'Per-seat DLP add-on (yearly, save ~16%).',
  1, 'yearly', 'addon', true, true,
  1999.00, 27.00, 1399.30,
  ARRAY['dlp']::text[], false,
  0.00, 0.00, 0.00)
ON CONFLICT (code) DO NOTHING;

-- EM add-on (per-seat, layered onto Professional)
INSERT INTO public.plans (
  code, name, description,
  seat_count, billing_cycle, family, is_active, is_addon,
  price_inr, price_usd, partner_price_inr,
  features_included, is_em_standalone,
  em_addon_price_inr, em_addon_price_usd, dlp_addon_price_inr
) VALUES
('em-addon-m', 'Employee Management Add-on', 'Per-seat EM features for Professional customers. Stack onto Pro.',
  1, 'monthly', 'addon', true, true,
  499.00, 7.00, 349.30,
  ARRAY['employee_management']::text[], false,
  0.00, 0.00, 0.00),
('em-addon-y', 'Employee Management Add-on', 'Per-seat EM add-on (yearly, save ~16%).',
  1, 'yearly', 'addon', true, true,
  4999.00, 67.00, 3499.30,
  ARRAY['employee_management']::text[], false,
  0.00, 0.00, 0.00)
ON CONFLICT (code) DO NOTHING;

-- 3. Helper: org_features(org_id) RPC returns the EFFECTIVE feature set
--    (base plan ∪ active add-ons). Used by useFeatures on the dashboard
--    and by edge functions / agent settings to gate behavior.
--
-- An org's "active" subscriptions come from organizations.plan_id (legacy
-- single-plan) plus a new `org_addons` table (introduced below) for stacked
-- add-ons. Until org_addons rows exist, this falls back to plan features
-- only — backwards-compatible with current behavior.
CREATE TABLE IF NOT EXISTS public.org_addons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES public.plans(id),
  seat_count  integer NOT NULL CHECK (seat_count > 0),
  active      boolean NOT NULL DEFAULT true,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  razorpay_subscription_id text,
  UNIQUE (org_id, plan_id, active) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS org_addons_org_idx ON public.org_addons(org_id) WHERE active;

ALTER TABLE public.org_addons ENABLE ROW LEVEL SECURITY;

-- Org members can SEE their org's add-ons. Inserts/updates go through edge
-- functions with service_role only — never direct client writes.
DROP POLICY IF EXISTS org_addons_read_org_members ON public.org_addons;
DROP POLICY IF EXISTS org_addons_block_writes ON public.org_addons;
DROP POLICY IF EXISTS org_addons_block_updates ON public.org_addons;
DROP POLICY IF EXISTS org_addons_block_deletes ON public.org_addons;
CREATE POLICY org_addons_read_org_members ON public.org_addons
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.org_members
       WHERE org_id = org_addons.org_id
         AND user_id = auth.uid()
    )
  );

CREATE POLICY org_addons_block_writes ON public.org_addons
  FOR INSERT WITH CHECK (false);
CREATE POLICY org_addons_block_updates ON public.org_addons
  FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY org_addons_block_deletes ON public.org_addons
  FOR DELETE USING (false);

-- 4. SECURITY DEFINER function so useFeatures can call it without
--    leaking through RLS gymnastics.
CREATE OR REPLACE FUNCTION public.org_effective_features(p_org_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Base plan: from the org's most recent active license. An org can have
  -- multiple licenses historically (renewals); pick the latest active one.
  WITH base AS (
    SELECT p.features_included
      FROM public.licenses l
      JOIN public.plans p ON p.id = l.plan_id
     WHERE l.organization_id = p_org_id
       AND l.status = 'active'
     ORDER BY l.issued_at DESC
     LIMIT 1
  ),
  addons AS (
    SELECT p.features_included
      FROM public.org_addons a
      JOIN public.plans p ON p.id = a.plan_id
     WHERE a.org_id = p_org_id AND a.active
  ),
  all_features AS (
    SELECT unnest(features_included) AS f FROM base
    UNION
    SELECT unnest(features_included) AS f FROM addons
  )
  SELECT COALESCE(array_agg(DISTINCT f), ARRAY[]::text[]) FROM all_features;
$$;

GRANT EXECUTE ON FUNCTION public.org_effective_features(uuid) TO authenticated, anon;

COMMIT;
