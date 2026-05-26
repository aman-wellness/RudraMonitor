-- The OAuth signup path (Google / Microsoft) uses the
-- public.create_self_signup_trial() RPC, while the password+OTP flow
-- uses the start-trial-signup edge function. 0075 only fixed the edge
-- function — the RPC was still picking the cheapest plan AND not
-- writing trial_plan_code, so OAuth signups kept landing on the wrong
-- plan with the legacy "all features unlocked" trial.
--
-- This migration:
--   * Adds an optional p_trial_plan text argument (defaults to
--     'starter-m'). The /complete-signup page passes the customer's
--     selection here.
--   * Picks the plan by code (not by price). Rejects anything that
--     isn't an explicitly trial-eligible plan.
--   * Writes trial_plan_code and trial_full_access=false on the org
--     so org_effective_features() returns the plan-scoped feature set.

CREATE OR REPLACE FUNCTION public.create_self_signup_trial(
  p_org_name   text,
  p_phone      text DEFAULT NULL,
  p_country    text DEFAULT 'India',
  p_trial_plan text DEFAULT 'starter-m'
) RETURNS TABLE(organization_id uuid, license_id uuid, license_key text, trial_ends_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_plan_code     text := COALESCE(NULLIF(trim(p_trial_plan), ''), 'starter-m');
  v_plan_id       uuid;
  v_plan_seats    int;
  v_plan_cycle    text;
  v_org_id        uuid;
  v_lic_id        uuid;
  v_lic_key       text;
  v_trial_until   timestamptz := now() + interval '14 days';
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING errcode = '42501'; END IF;
  IF length(COALESCE(trim(p_org_name),'')) = 0 THEN
    RAISE EXCEPTION 'organization name required' USING errcode = '22023';
  END IF;
  IF v_plan_code NOT IN ('starter-m', 'em-m') THEN
    RAISE EXCEPTION 'Invalid trial plan. Allowed: starter-m, em-m' USING errcode = '22023';
  END IF;

  SELECT id, seat_count, billing_cycle
    INTO v_plan_id, v_plan_seats, v_plan_cycle
    FROM public.plans
   WHERE code = v_plan_code AND is_active = true;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'Trial plan % is not configured', v_plan_code USING errcode = '22023';
  END IF;

  INSERT INTO public.organizations (
    owner_user_id, name, phone, country,
    subscription_status, subscription_type, trial_ends_at, license_count,
    trial_plan_code, trial_full_access
  )
  VALUES (
    v_uid, p_org_name, p_phone, p_country,
    'trial', v_plan_cycle, v_trial_until, v_plan_seats,
    v_plan_code, false
  )
  RETURNING id INTO v_org_id;

  INSERT INTO public.org_members (org_id, user_id, role, full_name)
  VALUES (v_org_id, v_uid, 'owner',
          (SELECT COALESCE(raw_user_meta_data->>'full_name', email) FROM auth.users WHERE id = v_uid))
  ON CONFLICT (org_id, user_id) DO NOTHING;

  INSERT INTO public.licenses (
    organization_id, plan_id, seat_count, status, issued_by, expires_at, notes
  )
  VALUES (v_org_id, v_plan_id, v_plan_seats, 'active', v_uid, v_trial_until,
          'Self-signup trial (OAuth)')
  RETURNING id, licenses.license_key INTO v_lic_id, v_lic_key;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (v_uid, 'customer', 'customer.self_signup', 'organization', v_org_id,
          jsonb_build_object('plan_id', v_plan_id, 'plan_code', v_plan_code, 'trial_ends_at', v_trial_until));

  RETURN QUERY SELECT v_org_id, v_lic_id, v_lic_key, v_trial_until;
END$$;

-- Keep the old 3-arg signature working (OAuth UI may still be on stale JS).
-- Drops only if exists, then grants on the new 4-arg variant.
GRANT EXECUTE ON FUNCTION public.create_self_signup_trial(text, text, text, text) TO authenticated;
