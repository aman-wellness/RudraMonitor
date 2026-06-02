-- 0095_finalize_pending_signup_trial_plan_code.sql
--
-- finalize_pending_signup_v2 (Razorpay subscription.authenticated path) was
-- never updated to write trial_plan_code on the new organization. Result:
-- every Razorpay-flow signup landed with trial_plan_code=NULL, and
-- org_effective_features() hit its "legacy NULL → unlock everything" branch,
-- so a Starter trial saw every feature (DLP, Employees, Credentials Vault…)
-- instead of just monitoring_basic.
--
-- 0076 fixed the OAuth/RPC create_self_signup_trial path; this is the
-- matching fix for the Razorpay path.

BEGIN;

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

  -- Idempotency.
  if v_pending.status = 'completed' and v_pending.organization_id is not null then
    return query
      select v_pending.organization_id, l.id, l.license_key, o.trial_ends_at
      from public.organizations o
      left join public.licenses l on l.organization_id = o.id
      where o.id = v_pending.organization_id
      order by l.issued_at desc nulls last limit 1;
    return;
  end if;

  -- Pull the plan's billing cycle, seat count, AND code. The plan code is
  -- what org_effective_features() reads to scope the trial to the right
  -- feature set. Without it, the trial unlocks every feature.
  select billing_cycle, seat_count, code
    into v_billing, v_seats, v_plan_code
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
  values (v_org_id, v_pending.plan_id, v_seats, 'active', p_user_id, v_trial, 'Self-signup trial (Razorpay)')
  returning id, licenses.license_key into v_lic_id, v_lic_key;

  update public.pending_signups
    set status = 'completed', organization_id = v_org_id, user_id = p_user_id,
        completed_at = now(),
        razorpay_customer_id = coalesce(razorpay_customer_id, p_customer_id)
    where id = v_pending.id;

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (p_user_id, 'system', 'customer.razorpay_signup', 'organization', v_org_id,
          jsonb_build_object('subscription_id', p_subscription_id, 'plan_id', v_pending.plan_id, 'trial_plan_code', v_plan_code));

  return query select v_org_id, v_lic_id, v_lic_key, v_trial;
end$function$;

-- Backfill: orgs that were finalized by this function pre-fix have
-- trial_plan_code=NULL → derive it from their active license's plan code so
-- their sidebar gates correctly now.
UPDATE public.organizations o
   SET trial_plan_code = p.code
  FROM public.licenses l
  JOIN public.plans p ON p.id = l.plan_id
 WHERE o.id = l.organization_id
   AND l.status = 'active'
   AND o.subscription_status = 'trial'
   AND o.trial_plan_code IS NULL
   AND o.razorpay_subscription_id IS NOT NULL;

COMMIT;
