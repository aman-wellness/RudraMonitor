-- Canonicalise `org_effective_features` output.
--
-- Two adjustments from the v1 definition (migration 0069):
--
-- 1. Map legacy feature codes onto the v2 canonical set:
--      productivity_reports -> monitoring_basic
--      screenshots          -> monitoring_basic + screenshots
--      video_recording      -> monitoring_basic + screenshots + videos
--      ai_alerts            -> monitoring_basic
--      dlp                  -> dlp                 (already canonical)
--    Without this, customers on legacy plans (`growth-25`, `scale-100`)
--    return raw codes that the new agent-settings function and any
--    future callers don't recognise, so every gated capability
--    silently turns off after we deployed Phase 5.
--
-- 2. Trial orgs (subscription_status='trial') unlock the whole canonical
--    set. The dashboard's useFeatures hook used to apply this on the
--    client; centralising it in the RPC keeps the server-side gates
--    (agent-settings, edge functions) honest too.

BEGIN;

CREATE OR REPLACE FUNCTION public.org_effective_features(p_org_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_raw    text[];
BEGIN
  SELECT subscription_status INTO v_status FROM public.organizations WHERE id = p_org_id;

  -- Trial: every feature unlocked while the org is evaluating.
  IF v_status = 'trial' THEN
    RETURN ARRAY[
      'monitoring_basic',
      'screenshots',
      'videos',
      'live',
      'remote',
      'dlp',
      'employee_management'
    ];
  END IF;

  -- Otherwise: union of base plan features + active add-on features.
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

  -- Legacy-code canonicalisation.
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
