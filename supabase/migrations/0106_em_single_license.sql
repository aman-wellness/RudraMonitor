-- 0106_em_single_license.sql
--
-- Employee Management plans (em-m, em-y) are a different product model from
-- the monitoring plans: ONE license covers an entire org's HR ops (up to
-- 2000 employees per plans.description). Customers don't deploy per-seat
-- agents — the product is a single tenant.
--
-- Three fixes:
--   1. finalize_pending_signup_v2 — trial signup on em-* plans gets 1 seat
--      (instead of the monitoring default of 25).
--   2. swap_org_plan — paid switch to em-* defaults to 1 seat unless the
--      caller explicitly passes more.
--   3. Backfill existing trial orgs already on em-* trial_plan_code so
--      their dashboard reflects "1 license — multi-employee" today.

BEGIN;

-- ── 1. Trial finalize: 1 seat for EM, 25 for monitoring ─────────────────
CREATE OR REPLACE FUNCTION public.finalize_pending_signup_v2(
  p_subscription_id text,
  p_user_id uuid,
  p_customer_id text DEFAULT NULL::text
)
RETURNS TABLE(organization_id uuid, license_id uuid, license_key text, trial_ends_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_pending   public.pending_signups%rowtype;
  v_org_id    uuid;
  v_lic_id    uuid;
  v_lic_key   text;
  v_seats     int;
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

  -- Employee-Management plans (em-m, em-y) are a single-license product —
  -- one license covers all employees. Monitoring trials get 25 trial seats
  -- so the customer can test deployment.
  v_seats := CASE
    WHEN v_plan_code LIKE 'em-%' AND v_plan_code NOT LIKE 'em-addon-%' THEN 1
    ELSE 25
  END;

  insert into public.organizations (
    owner_user_id, name, phone, country,
    subscription_status, subscription_type,
    trial_ends_at, license_count,
    razorpay_subscription_id, razorpay_customer_id, auth_payment_status,
    trial_plan_code, trial_full_access,
    gst_number, pan_number, address, city, state, postal_code
  )
  values (
    p_user_id, v_pending.org_name, v_pending.phone, v_pending.country,
    'trial', v_billing, v_trial, v_seats,
    p_subscription_id, p_customer_id, 'authenticated',
    v_plan_code, false,
    nullif(trim(v_pending.gst_number), ''),
    nullif(trim(v_pending.pan_number), ''),
    nullif(trim(v_pending.address), ''),
    nullif(trim(v_pending.city), ''),
    nullif(trim(v_pending.state), ''),
    nullif(trim(v_pending.postal_code), '')
  )
  returning id into v_org_id;

  insert into public.org_members (org_id, user_id, role, full_name)
  values (v_org_id, p_user_id, 'owner', v_pending.full_name_pending)
  on conflict (org_id, user_id) do nothing;

  insert into public.licenses (organization_id, plan_id, seat_count, status, issued_by, expires_at, notes)
  values (v_org_id, v_pending.plan_id, v_seats, 'active', p_user_id, v_trial,
          format('Self-signup trial (Razorpay) — %s seat%s', v_seats, CASE WHEN v_seats=1 THEN '' ELSE 's' END))
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

-- ── 2. swap_org_plan: EM defaults to 1 seat ──────────────────────────────
DROP FUNCTION IF EXISTS public.swap_org_plan(uuid, text, text, text, int);

CREATE OR REPLACE FUNCTION public.swap_org_plan(
  p_org_id uuid,
  p_new_plan_code text,
  p_razorpay_subscription_id text,
  p_razorpay_customer_id text DEFAULT NULL,
  p_seats int DEFAULT NULL  -- NULL → derive default from plan family
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
  v_default_seats int;
BEGIN
  SELECT * INTO v_plan FROM public.plans WHERE code = p_new_plan_code AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_code % not found / inactive', p_new_plan_code USING ERRCODE = 'P0002';
  END IF;
  IF v_plan.is_addon THEN
    RAISE EXCEPTION 'plan_code % is an add-on — use activate_org_addon', p_new_plan_code USING ERRCODE = '22023';
  END IF;

  -- Per-product seat default: EM = 1 (single-license), monitoring = 5.
  v_default_seats := CASE
    WHEN p_new_plan_code LIKE 'em-%' AND p_new_plan_code NOT LIKE 'em-addon-%' THEN 1
    ELSE 5
  END;
  v_seats := GREATEST(COALESCE(p_seats, v_default_seats), 1);

  UPDATE public.licenses
     SET status = 'expired'
   WHERE organization_id = p_org_id
     AND status = 'active'
     AND plan_id IN (SELECT id FROM public.plans WHERE NOT is_addon);

  INSERT INTO public.licenses (organization_id, plan_id, seat_count, status, expires_at, notes)
  VALUES (
    p_org_id, v_plan.id, v_seats, 'active', NULL,
    format('Plan upgrade to %s @ %s seat%s (Razorpay sub %s)',
           p_new_plan_code, v_seats, CASE WHEN v_seats=1 THEN '' ELSE 's' END, p_razorpay_subscription_id)
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

-- ── 3. Backfill: existing EM-trial orgs that were given 25 seats ────────
-- Down-correct them to 1 seat so the dashboard accurately reflects the
-- product model. Their licence_key is unchanged.
UPDATE public.organizations
   SET license_count = 1
 WHERE subscription_status = 'trial'
   AND trial_plan_code LIKE 'em-%'
   AND trial_plan_code NOT LIKE 'em-addon-%'
   AND license_count > 1;

UPDATE public.licenses l
   SET seat_count = 1
  FROM public.organizations o, public.plans p
 WHERE l.organization_id = o.id
   AND p.id = l.plan_id
   AND l.status = 'active'
   AND o.subscription_status = 'trial'
   AND p.code LIKE 'em-%'
   AND p.code NOT LIKE 'em-addon-%'
   AND l.seat_count > 1;

COMMIT;
