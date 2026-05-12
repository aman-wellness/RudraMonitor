-- Subscription / trial enforcement and renewal-extension RPC.
--
-- Goals:
--  1. Self-signup customers get 14 days of trial. After that the subscription
--     is "expired" — agents stop ingesting data, dashboards turn read-only.
--  2. Only super_admin can change a license's expires_at, status, plan_id, or
--     an org's subscription_status / trial_ends_at. Triggers enforce this even
--     if RLS is bypassed by a service role mistake.
--  3. Renewal-extension is centralized in one RPC: super_admin calls it with a
--     license_id and "periods" (default 1). It adds periods × billing_cycle
--     (1 month or 1 year) to expires_at and flips status to 'active'.
--  4. `is_subscription_active(org_id)` is the single source of truth used by
--     ingest, agent enrollment, dashboards.

-- ── 1. Single-source-of-truth check ────────────────────────────────────────
create or replace function public.is_subscription_active(p_org_id uuid)
returns boolean language sql stable as $$
  -- An org is "active" if:
  --   subscription_status NOT in ('expired','suspended','cancelled') AND
  --   (status != 'trial' OR trial_ends_at > now())                   AND
  --   at least one license is currently active (not expired/suspended).
  select
    coalesce((
      select
        o.subscription_status not in ('expired','suspended','cancelled')
        and (o.subscription_status <> 'trial' or o.trial_ends_at > now())
        and exists (
          select 1 from public.licenses l
          where l.organization_id = o.id
            and l.status = 'active'
            and l.expires_at > now()
        )
      from public.organizations o
      where o.id = p_org_id
    ), false);
$$;

grant execute on function public.is_subscription_active(uuid) to anon, authenticated, service_role;

-- ── 2. Lock organizations.subscription_status / trial_ends_at to super_admin ──
create or replace function public.organizations_protect_billing()
returns trigger language plpgsql as $$
begin
  -- Service role (used by edge functions for bookkeeping like razorpay-webhook
  -- calling the renewal RPC) is allowed to change these. Same for super_admin.
  -- All other roles are blocked.
  if auth.uid() is null then return new; end if;  -- service-role context
  if exists (select 1 from app_users where user_id = auth.uid() and app_role = 'super_admin') then
    return new;
  end if;
  if new.subscription_status is distinct from old.subscription_status
     or new.trial_ends_at is distinct from old.trial_ends_at then
    raise exception 'organizations.{subscription_status,trial_ends_at} are super-admin-only' using errcode = '42501';
  end if;
  return new;
end$$;

drop trigger if exists trg_orgs_protect_billing on public.organizations;
create trigger trg_orgs_protect_billing before update on public.organizations
  for each row execute function public.organizations_protect_billing();

-- ── 3. Lock licenses.{status,expires_at,plan_id,seat_count} to super_admin ──
create or replace function public.licenses_protect_renewal()
returns trigger language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  if exists (select 1 from app_users where user_id = auth.uid() and app_role = 'super_admin') then
    return new;
  end if;
  if new.status      is distinct from old.status
     or new.expires_at is distinct from old.expires_at
     or new.plan_id   is distinct from old.plan_id
     or new.seat_count is distinct from old.seat_count then
    raise exception 'licenses.{status,expires_at,plan_id,seat_count} are super-admin-only' using errcode = '42501';
  end if;
  return new;
end$$;

drop trigger if exists trg_licenses_protect_renewal on public.licenses;
create trigger trg_licenses_protect_renewal before update on public.licenses
  for each row execute function public.licenses_protect_renewal();

-- ── 4. Renewal-extension RPC ───────────────────────────────────────────────
-- Adds N billing periods to a license's expires_at and flips it active.
-- If a manual_until is supplied, that wins (super_admin can grant a custom date).
-- Webhook callers (Razorpay) pass periods=1; manual UI calls can pass any value.
drop function if exists public.extend_license_renewal(uuid, integer, timestamptz);
create or replace function public.extend_license_renewal(
  p_license_id uuid,
  p_periods    integer default 1,
  p_until      timestamptz default null
) returns table(license_id uuid, new_expires_at timestamptz, new_status text)
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role text;
  v_billing     text;
  v_current     timestamptz;
  v_new_exp     timestamptz;
  v_org         uuid;
  v_caller      uuid := auth.uid();
begin
  -- Service role context (Razorpay webhook) doesn't have auth.uid(). Allow it.
  if v_caller is not null then
    select app_role into v_caller_role from app_users where user_id = v_caller;
    if v_caller_role <> 'super_admin' then
      raise exception 'forbidden: only super_admin can extend a license' using errcode = '42501';
    end if;
  end if;

  if p_periods < 1 or p_periods > 24 then
    raise exception 'periods must be between 1 and 24' using errcode = '22023';
  end if;

  select l.expires_at, l.organization_id, p.billing_cycle
    into v_current, v_org, v_billing
  from public.licenses l
  join public.plans p on p.id = l.plan_id
  where l.id = p_license_id;

  if v_org is null then
    raise exception 'license not found' using errcode = '22023';
  end if;

  -- Renew from whichever is later: now() or current expiry. So extending an
  -- already-expired license adds time starting today, not from a stale past
  -- date — but a still-valid license is extended from its existing date.
  if p_until is not null then
    v_new_exp := p_until;
  else
    v_new_exp := greatest(v_current, now()) +
                 case when v_billing = 'yearly'
                      then make_interval(years  => p_periods)
                      else make_interval(months => p_periods)
                 end;
  end if;

  update public.licenses
    set expires_at = v_new_exp, status = 'active'
    where id = p_license_id;

  -- Re-activate the organization too (if it was in trial/expired/suspended).
  update public.organizations
    set subscription_status = 'active'
    where id = v_org and subscription_status in ('trial','expired','suspended');

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (v_caller, coalesce(v_caller_role,'system'), 'license.renew', 'license', p_license_id,
          jsonb_build_object('periods', p_periods, 'until', p_until, 'new_expires_at', v_new_exp));

  return query select p_license_id, v_new_exp, 'active'::text;
end$$;

grant execute on function public.extend_license_renewal(uuid, integer, timestamptz) to authenticated, service_role;

-- ── 5. Public self-signup RPC for the website /signup flow ─────────────────
-- Creates an organization + 14-day trial license bound to the just-signed-up user.
-- Picks the cheapest active plan as the trial plan (admin can move them later).
create or replace function public.create_self_signup_trial(
  p_org_name text,
  p_phone    text default null,
  p_country  text default 'India'
) returns table(organization_id uuid, license_id uuid, license_key text, trial_ends_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_plan_id uuid;
  v_seats   int;
  v_org_id  uuid;
  v_lic_id  uuid;
  v_lic_key text;
  v_trial_until timestamptz := now() + interval '14 days';
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if length(coalesce(trim(p_org_name),'')) = 0 then
    raise exception 'organization name required' using errcode = '22023';
  end if;

  -- Pick the smallest active plan as the default trial plan.
  select id, seat_count into v_plan_id, v_seats
    from public.plans where is_active = true order by seat_count asc, price_inr asc limit 1;
  if v_plan_id is null then
    raise exception 'no active plans configured' using errcode = '22023';
  end if;

  insert into public.organizations (
    owner_user_id, name, phone, country,
    subscription_status, subscription_type, trial_ends_at, license_count
  )
  values (v_uid, p_org_name, p_phone, p_country, 'trial', 'monthly', v_trial_until, v_seats)
  returning id into v_org_id;

  -- Owner membership row.
  insert into public.org_members (org_id, user_id, role, full_name)
  values (v_org_id, v_uid, 'owner',
          (select coalesce(raw_user_meta_data->>'full_name', email) from auth.users where id = v_uid))
  on conflict (org_id, user_id) do nothing;

  -- Trial license — expires same day as the trial ends.
  insert into public.licenses (
    organization_id, plan_id, seat_count, status, issued_by, expires_at, notes
  )
  values (v_org_id, v_plan_id, v_seats, 'active', v_uid, v_trial_until, 'Self-signup trial')
  returning id, licenses.license_key into v_lic_id, v_lic_key;

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (v_uid, 'customer', 'customer.self_signup', 'organization', v_org_id,
          jsonb_build_object('plan_id', v_plan_id, 'trial_ends_at', v_trial_until));

  return query select v_org_id, v_lic_id, v_lic_key, v_trial_until;
end$$;

grant execute on function public.create_self_signup_trial(text, text, text) to authenticated;
