-- 0096_upgrade_rpcs.sql
--
-- RPCs invoked by the razorpay-webhook when a payment-driven upgrade
-- completes. Both are SECURITY DEFINER because they touch licenses /
-- org_addons / organizations (all locked by RLS).

BEGIN;

-- swap_org_plan: replace the org's active main-plan license with a license
-- on the target plan, and clear trial state (since they just paid).
CREATE OR REPLACE FUNCTION public.swap_org_plan(
  p_org_id uuid,
  p_new_plan_code text,
  p_razorpay_subscription_id text,
  p_razorpay_customer_id text DEFAULT NULL
)
RETURNS uuid  -- new license id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_plan          public.plans%ROWTYPE;
  v_new_lic_id    uuid;
  v_seats         int;
BEGIN
  SELECT * INTO v_plan FROM public.plans WHERE code = p_new_plan_code AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_code % not found / inactive', p_new_plan_code USING ERRCODE = 'P0002';
  END IF;
  IF v_plan.is_addon THEN
    RAISE EXCEPTION 'plan_code % is an add-on — use activate_org_addon', p_new_plan_code USING ERRCODE = '22023';
  END IF;

  -- Expire the current active main-plan license (skip add-on licenses; those
  -- live in org_addons not licenses, so we don't touch them here).
  UPDATE public.licenses
     SET status = 'expired'
   WHERE organization_id = p_org_id
     AND status = 'active'
     AND plan_id IN (SELECT id FROM public.plans WHERE NOT is_addon);

  SELECT COALESCE(license_count, v_plan.seat_count) INTO v_seats
    FROM public.organizations WHERE id = p_org_id;

  INSERT INTO public.licenses (
    organization_id, plan_id, seat_count, status,
    expires_at, notes
  )
  VALUES (
    p_org_id, v_plan.id, v_seats, 'active',
    NULL, format('Plan upgrade to %s (Razorpay sub %s)', p_new_plan_code, p_razorpay_subscription_id)
  )
  RETURNING id INTO v_new_lic_id;

  -- Clear trial state, mark active.
  UPDATE public.organizations
     SET subscription_status   = 'active',
         subscription_type     = v_plan.billing_cycle,
         trial_plan_code       = NULL,
         trial_full_access     = false,
         razorpay_subscription_id = p_razorpay_subscription_id,
         razorpay_customer_id     = COALESCE(p_razorpay_customer_id, razorpay_customer_id),
         auth_payment_status      = 'authenticated'
   WHERE id = p_org_id;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (NULL, 'system', 'org.plan_switched', 'organization', p_org_id,
          jsonb_build_object('new_plan_code', p_new_plan_code, 'subscription_id', p_razorpay_subscription_id));

  RETURN v_new_lic_id;
END;
$$;

-- activate_org_addon: insert (or reactivate) a row in org_addons for the
-- given add-on plan, tied to the addon's own Razorpay subscription.
CREATE OR REPLACE FUNCTION public.activate_org_addon(
  p_org_id uuid,
  p_addon_plan_code text,
  p_razorpay_subscription_id text
)
RETURNS uuid  -- org_addons.id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_plan       public.plans%ROWTYPE;
  v_seats      int;
  v_existing   uuid;
BEGIN
  SELECT * INTO v_plan FROM public.plans WHERE code = p_addon_plan_code AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'addon plan_code % not found / inactive', p_addon_plan_code USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_plan.is_addon THEN
    RAISE EXCEPTION 'plan_code % is not an add-on', p_addon_plan_code USING ERRCODE = '22023';
  END IF;

  SELECT license_count INTO v_seats
    FROM public.organizations WHERE id = p_org_id;
  IF v_seats IS NULL OR v_seats <= 0 THEN v_seats := 1; END IF;

  -- Reactivate an existing inactive row if present, otherwise insert fresh.
  SELECT id INTO v_existing
    FROM public.org_addons
   WHERE org_id = p_org_id AND plan_id = v_plan.id AND active = false
   ORDER BY started_at DESC LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE public.org_addons
       SET active = true,
           started_at = now(),
           ends_at = NULL,
           seat_count = v_seats,
           razorpay_subscription_id = p_razorpay_subscription_id
     WHERE id = v_existing;
    RETURN v_existing;
  END IF;

  INSERT INTO public.org_addons (org_id, plan_id, seat_count, active, razorpay_subscription_id)
  VALUES (p_org_id, v_plan.id, v_seats, true, p_razorpay_subscription_id)
  ON CONFLICT (org_id, plan_id, active) DO UPDATE
    SET razorpay_subscription_id = EXCLUDED.razorpay_subscription_id,
        started_at = now(),
        seat_count = EXCLUDED.seat_count
  RETURNING id INTO v_existing;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (NULL, 'system', 'org.addon_activated', 'organization', p_org_id,
          jsonb_build_object('addon_code', p_addon_plan_code, 'subscription_id', p_razorpay_subscription_id));

  RETURN v_existing;
END;
$$;

GRANT EXECUTE ON FUNCTION public.swap_org_plan(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_org_addon(uuid, text, text) TO service_role;

COMMIT;
