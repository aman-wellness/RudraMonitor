-- 0100_trial_path_includes_addons.sql
--
-- org_effective_features's trial path was returning ONLY the trial_plan_code's
-- features. Customers who activated DLP / EM add-ons during the trial saw
-- their main-plan features but NOT the add-on's — so the sidebar didn't show
-- DLP even after the customer paid the ₹2 verify and got the add-on row.
--
-- Union add-on features into the trial path so behavior matches the paid path.

BEGIN;

CREATE OR REPLACE FUNCTION public.org_effective_features(p_org_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    IF v_org.trial_full_access = true THEN
      RETURN ARRAY[
        'monitoring_basic', 'screenshots', 'videos',
        'live', 'remote', 'dlp', 'employee_management'
      ];
    END IF;
    IF v_org.trial_plan_code IS NULL THEN
      RETURN ARRAY[
        'monitoring_basic', 'screenshots', 'videos',
        'live', 'remote', 'dlp', 'employee_management'
      ];
    END IF;
    -- Plan-scoped trial WITH add-ons unioned in.
    WITH base AS (
      SELECT features_included FROM public.plans WHERE code = v_org.trial_plan_code
    ),
    addons AS (
      SELECT p.features_included FROM public.org_addons a
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
      v_raw := ARRAY['monitoring_basic']::text[];
    END IF;
  ELSE
    -- Paid path: license + addons.
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

  -- Legacy code canonicalisation (unchanged from 0095/0075).
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
$function$;

COMMIT;
