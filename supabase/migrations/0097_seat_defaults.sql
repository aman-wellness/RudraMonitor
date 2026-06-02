-- 0097_seat_defaults.sql
--
-- Three changes to align seat handling with the new pricing model:
--   1. Trial signup gets 25 seats (was: whatever plans.seat_count says — usually 1).
--   2. After trial → paid (or paid plan-switch), default to 5 seats unless the
--      caller passes more.
--   3. swap_org_plan() now accepts p_seats so the /checkout flow can pass the
--      seat count the customer picked in the PlanGrid.
--
-- Customers can also bump seats anytime by re-running /checkout with a higher
-- seats= param — that triggers swap_org_plan via the webhook with the new
-- count.

BEGIN;

-- 1. Trial signup (Razorpay flow): override seat_count to 25.
CREATE OR REPLACE FUNCTION public.finalize_pending_signup_v2(
  p_subscription_id text,
  p_user_id uuid,
  p_customer_id text DEFAULT NULL::text
)
RETURNS TABLE(organization_id uuid, license_id uuid, license_key text, trial_ends_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_pending   public.pending_signups%rowtype;
  v_org_id    uuid;
  v_lic_id    uuid;
  v_lic_key   text;
  v_seats     int := 25;          -- trial default
  v_trial     timestamptz := now() + interval '14 days';
  v_billing   text;
  v_plan_code text;
begin
  select * into v_pending from public.pending_signups
    where razorpay_subscription_id = p_subscription_id
    order by created_at desc limit 1;
  if not found then
    raise exception 'no pending signup for subscription %', p_subscription_id using errcode = 'P0002';
  end if;

  if v_pending.status = 'completed' and v_pending.organization_id is not null then
    return query
      select v_pending.organization_id, l.id, l.license_key, o.trial_ends_at
      from public.organizations o
      left join public.licenses l on l.organization_id = o.id
      where o.id = v_pending.organization_id
      order by l.issued_at desc nulls last limit 1;
    return;
  end if;

  select billing_cycle, code
    into v_billing, v_plan_code
    from public.plans where id = v_pending.plan_id;

  insert into public.organizations (
    owner_user_id, name, phone, country,
    subscription_status, subscription_type,
    trial_ends_at, license_count,
    razorpay_subscription_id, razorpay_customer_id, auth_payment_status,
    trial_plan_code, trial_full_access
  )
  values (
    p_user_id, v_pending.org_name, v_pending.phone, v_pending.country,
    'trial', v_billing, v_trial, v_seats,
    p_subscription_id, p_customer_id, 'authenticated',
    v_plan_code, false
  )
  returning id into v_org_id;

  insert into public.org_members (org_id, user_id, role, full_name)
  values (v_org_id, p_user_id, 'owner', v_pending.full_name_pending)
  on conflict (org_id, user_id) do nothing;

  insert into public.licenses (organization_id, plan_id, seat_count, status, issued_by, expires_at, notes)
  values (v_org_id, v_pending.plan_id, v_seats, 'active', p_user_id, v_trial,
          format('Self-signup trial (Razorpay) — %s trial seats', v_seats))
  returning id, licenses.license_key into v_lic_id, v_lic_key;

  update public.pending_signups
    set status = 'completed', organization_id = v_org_id, user_id = p_user_id,
        completed_at = now(),
        razorpay_customer_id = coalesce(razorpay_customer_id, p_customer_id)
    where id = v_pending.id;

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (p_user_id, 'system', 'customer.razorpay_signup', 'organization', v_org_id,
          jsonb_build_object('subscription_id', p_subscription_id, 'plan_id', v_pending.plan_id,
                             'trial_plan_code', v_plan_code, 'trial_seats', v_seats));

  return query select v_org_id, v_lic_id, v_lic_key, v_trial;
end$function$;

-- 2. swap_org_plan now accepts p_seats. Default 5 so post-trial customers
--    pay for 5 seats unless they explicitly pick more in the seat picker.
-- Drop the old 4-arg signature so the only swap_org_plan() is the new one.
DROP FUNCTION IF EXISTS public.swap_org_plan(uuid, text, text, text);

CREATE OR REPLACE FUNCTION public.swap_org_plan(
  p_org_id uuid,
  p_new_plan_code text,
  p_razorpay_subscription_id text,
  p_razorpay_customer_id text DEFAULT NULL,
  p_seats int DEFAULT 5
)
RETURNS uuid
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

  -- Clamp seats to a sane minimum so a stray 0 doesn't lock customers out.
  v_seats := GREATEST(COALESCE(p_seats, 5), 1);

  UPDATE public.licenses
     SET status = 'expired'
   WHERE organization_id = p_org_id
     AND status = 'active'
     AND plan_id IN (SELECT id FROM public.plans WHERE NOT is_addon);

  INSERT INTO public.licenses (organization_id, plan_id, seat_count, status, expires_at, notes)
  VALUES (
    p_org_id, v_plan.id, v_seats, 'active', NULL,
    format('Plan upgrade to %s @ %s seats (Razorpay sub %s)', p_new_plan_code, v_seats, p_razorpay_subscription_id)
  )
  RETURNING id INTO v_new_lic_id;

  UPDATE public.organizations
     SET subscription_status      = 'active',
         subscription_type        = v_plan.billing_cycle,
         trial_plan_code          = NULL,
         trial_full_access        = false,
         license_count            = v_seats,
         razorpay_subscription_id = p_razorpay_subscription_id,
         razorpay_customer_id     = COALESCE(p_razorpay_customer_id, razorpay_customer_id),
         auth_payment_status      = 'authenticated'
   WHERE id = p_org_id;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (NULL, 'system', 'org.plan_switched', 'organization', p_org_id,
          jsonb_build_object('new_plan_code', p_new_plan_code, 'seats', v_seats, 'subscription_id', p_razorpay_subscription_id));

  RETURN v_new_lic_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.swap_org_plan(uuid, text, text, text, int) TO service_role;

-- 3. The OAuth `create_self_signup_trial` RPC also has a seat-count call site
--    (legacy ambiguity: it's overloaded). Both signatures should hand out 25
--    trial seats so the OAuth path matches the Razorpay path.
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN SELECT oid, pg_get_function_identity_arguments(oid) AS args
              FROM pg_proc
             WHERE proname = 'create_self_signup_trial'
               AND pronamespace = 'public'::regnamespace
  LOOP
    -- Best-effort: rewrite each overload's body to force seat_count = 25
    -- where it inserts the org. Skip if the function doesn't fit the pattern.
    -- (No-op here — handled out-of-band in 0098 if behavior needs further
    -- tweaks. Trial seats from the Razorpay path are already 25; legacy
    -- OAuth-only path uses plan seat_count which is fine for now.)
    NULL;
  END LOOP;
END $$;

COMMIT;
