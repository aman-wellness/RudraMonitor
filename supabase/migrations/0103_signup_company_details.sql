-- 0103_signup_company_details.sql
--
-- Capture full company details at signup (GST, PAN, address, city, state,
-- postal code) — used for tax-compliant invoicing + sales follow-up. All
-- optional except `org_name`, which was already required.
--
-- Flow:
--   1. signup form collects these → razorpay-start-signup stores them on
--      pending_signups
--   2. finalize_pending_signup_v2 copies them onto organizations when the
--      payment authenticates
--
-- Backward-compatible: existing pending rows just default to NULL.

BEGIN;

ALTER TABLE public.pending_signups
  ADD COLUMN IF NOT EXISTS gst_number  text,
  ADD COLUMN IF NOT EXISTS pan_number  text,
  ADD COLUMN IF NOT EXISTS address     text,
  ADD COLUMN IF NOT EXISTS city        text,
  ADD COLUMN IF NOT EXISTS state       text,
  ADD COLUMN IF NOT EXISTS postal_code text;

-- finalize_pending_signup_v2 now copies the company-detail columns to
-- organizations during creation. Same idempotency / search_path semantics
-- as 0097 — only the columns inserted on the new org changed.
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
  v_seats     int := 25;
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

COMMIT;
