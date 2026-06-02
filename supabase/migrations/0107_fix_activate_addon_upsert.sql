-- 0107_fix_activate_addon_upsert.sql
--
-- activate_org_addon used ON CONFLICT (org_id, plan_id, active) DO UPDATE,
-- but that unique constraint was created DEFERRABLE INITIALLY DEFERRED in
-- migration 0099. Postgres rejects ON CONFLICT against deferrable
-- uniques with:
--   "ON CONFLICT does not support deferrable unique constraints/exclusion
--    constraints as arbiters"
--
-- Result: every webhook-driven addon activation for an org that already
-- had an inactive (or even fresh) row crashed silently. Som Info paid ₹499
-- for em-addon-m on 2026-06-02 — payment captured by Razorpay, but the
-- webhook called this RPC, hit this error, and the org_addons row was
-- never written.
--
-- Fix: replace the ON CONFLICT with an explicit existence check + branch.

BEGIN;

CREATE OR REPLACE FUNCTION public.activate_org_addon(
  p_org_id uuid,
  p_addon_plan_code text,
  p_razorpay_subscription_id text,
  p_seats int DEFAULT NULL
)
RETURNS uuid
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

  IF p_seats IS NULL OR p_seats <= 0 THEN
    SELECT license_count INTO v_seats FROM public.organizations WHERE id = p_org_id;
    IF v_seats IS NULL OR v_seats <= 0 THEN v_seats := 1; END IF;
  ELSE
    v_seats := GREATEST(1, LEAST(p_seats, 10000));
  END IF;

  -- Path A: an ACTIVE row already exists for this (org, plan) — refresh it.
  SELECT id INTO v_existing
    FROM public.org_addons
   WHERE org_id = p_org_id AND plan_id = v_plan.id AND active = true
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    UPDATE public.org_addons
       SET seat_count = v_seats,
           razorpay_subscription_id = p_razorpay_subscription_id,
           started_at = now(),
           ends_at = NULL
     WHERE id = v_existing;
    INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
    VALUES (NULL, 'system', 'org.addon_refreshed', 'organization', p_org_id,
            jsonb_build_object('addon_code', p_addon_plan_code, 'seats', v_seats, 'subscription_id', p_razorpay_subscription_id));
    RETURN v_existing;
  END IF;

  -- Path B: a previously-inactive row exists — reactivate it.
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
    INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
    VALUES (NULL, 'system', 'org.addon_reactivated', 'organization', p_org_id,
            jsonb_build_object('addon_code', p_addon_plan_code, 'seats', v_seats, 'subscription_id', p_razorpay_subscription_id));
    RETURN v_existing;
  END IF;

  -- Path C: no row at all — plain insert. The deferrable unique index
  -- still prevents concurrent duplicates at COMMIT time, which is the
  -- behaviour we want here.
  INSERT INTO public.org_addons (org_id, plan_id, seat_count, active, razorpay_subscription_id)
  VALUES (p_org_id, v_plan.id, v_seats, true, p_razorpay_subscription_id)
  RETURNING id INTO v_existing;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (NULL, 'system', 'org.addon_activated', 'organization', p_org_id,
          jsonb_build_object('addon_code', p_addon_plan_code, 'seats', v_seats, 'subscription_id', p_razorpay_subscription_id));

  RETURN v_existing;
END;
$$;

GRANT EXECUTE ON FUNCTION public.activate_org_addon(uuid, text, text, int) TO service_role;

COMMIT;
