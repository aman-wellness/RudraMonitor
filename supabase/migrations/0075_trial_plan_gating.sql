-- Tighter trial semantics. Until now:
--   * Signup picked the cheapest active plan → after the new pricing
--     migrations, that's the DLP add-on (₹199) which is wrong for a
--     base trial.
--   * `org_effective_features` returned EVERY feature for any
--     subscription_status='trial' org, so a Starter-trial customer
--     saw + used DLP / Live / Remote / EM — features they never
--     signed up for and won't be paying for.
--
-- New model:
--   * organizations.trial_plan_code → which v2 plan this trial is for.
--     Default for new signups: 'starter-m' (basic monitoring only).
--     If signup flow ever surfaces a "I want EM-only" choice, store
--     'em-m' here instead. Multi-tier upgrade post-conversion still
--     drives off licenses.plan_id as before.
--   * organizations.trial_full_access → super-admin override. Flips
--     to true only after an org's trial_extension_request is approved
--     (see new table below). When true, the RPC returns every feature
--     (back-compat with the old behaviour, but consented to + audited).
--   * trial_extension_requests → audit + workflow trail. Customer
--     clicks "Request full-features trial" in /subscription → row
--     inserted with status='pending'. Super-admin approves/denies in
--     /admin/customers → status flips + trial_full_access mirrors.
--
-- Existing legacy orgs already on trial keep working: trial_plan_code
-- backfills to NULL (treated as "all features" by the RPC so we don't
-- yank capabilities mid-evaluation). New signups land with an explicit
-- starter trial.

BEGIN;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS trial_plan_code   text,
  ADD COLUMN IF NOT EXISTS trial_full_access boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS organizations_trial_plan_idx
  ON public.organizations (trial_plan_code)
  WHERE subscription_status = 'trial';

CREATE TABLE IF NOT EXISTS public.trial_extension_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES auth.users(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  reason          text,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  decided_by      uuid REFERENCES auth.users(id),
  decided_at      timestamptz,
  decision_note   text
);

CREATE INDEX IF NOT EXISTS trial_extension_requests_pending_idx
  ON public.trial_extension_requests (status, requested_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS trial_extension_requests_org_idx
  ON public.trial_extension_requests (org_id, requested_at DESC);

ALTER TABLE public.trial_extension_requests ENABLE ROW LEVEL SECURITY;

-- Org admins can SEE their own org's requests (so the Subscription page
-- can show "Request pending" status). Inserts go through an edge fn
-- with service role so we can rate-limit + validate.
CREATE POLICY trial_extension_read_org_admins ON public.trial_extension_requests
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members
      WHERE org_id = trial_extension_requests.org_id
        AND user_id = auth.uid()
        AND role IN ('admin', 'owner')
    )
    OR public.is_super_admin()
  );

CREATE POLICY trial_extension_block_writes ON public.trial_extension_requests
  FOR INSERT WITH CHECK (false);
CREATE POLICY trial_extension_block_updates ON public.trial_extension_requests
  FOR UPDATE USING (false) WITH CHECK (false);

-- Re-define org_effective_features. Trial path now reads trial_plan_code
-- (or unlocks everything if super-admin approved trial_full_access).
CREATE OR REPLACE FUNCTION public.org_effective_features(p_org_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org public.organizations%ROWTYPE;
  v_raw text[];
BEGIN
  SELECT * INTO v_org FROM public.organizations WHERE id = p_org_id;
  IF NOT FOUND THEN
    RETURN ARRAY[]::text[];
  END IF;

  -- Trial path.
  IF v_org.subscription_status = 'trial' THEN
    -- Super admin granted full-features trial: unlock everything.
    IF v_org.trial_full_access = true THEN
      RETURN ARRAY[
        'monitoring_basic', 'screenshots', 'videos',
        'live', 'remote', 'dlp', 'employee_management'
      ];
    END IF;
    -- Plan-scoped trial. Pull features_included from the trial_plan_code
    -- row. If trial_plan_code is NULL (legacy org pre-this-migration),
    -- preserve the old behaviour and unlock everything — we don't yank
    -- capabilities mid-evaluation.
    IF v_org.trial_plan_code IS NULL THEN
      RETURN ARRAY[
        'monitoring_basic', 'screenshots', 'videos',
        'live', 'remote', 'dlp', 'employee_management'
      ];
    END IF;
    SELECT features_included INTO v_raw FROM public.plans
      WHERE code = v_org.trial_plan_code;
    IF v_raw IS NULL THEN
      v_raw := ARRAY['monitoring_basic']::text[];
    END IF;
  ELSE
    -- Paid path: union of licensed plan + active add-ons.
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
    all_raw AS (
      SELECT unnest(features_included) AS f FROM base
      UNION
      SELECT unnest(features_included) AS f FROM addons
    )
    SELECT array_agg(DISTINCT f) INTO v_raw FROM all_raw;
    IF v_raw IS NULL THEN
      RETURN ARRAY[]::text[];
    END IF;
  END IF;

  -- Legacy code canonicalisation (kept from 0070).
  RETURN (
    SELECT array_agg(DISTINCT mapped)
      FROM (
        SELECT unnest(CASE
          WHEN f = 'productivity_reports' THEN ARRAY['monitoring_basic']
          WHEN f = 'screenshots'          THEN ARRAY['monitoring_basic','screenshots']
          WHEN f = 'video_recording'      THEN ARRAY['monitoring_basic','screenshots','videos']
          WHEN f = 'ai_alerts'            THEN ARRAY['monitoring_basic']
          ELSE ARRAY[f]
        END) AS mapped
          FROM unnest(v_raw) AS t(f)
      ) sub
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.org_effective_features(uuid) TO authenticated, anon;

COMMIT;
