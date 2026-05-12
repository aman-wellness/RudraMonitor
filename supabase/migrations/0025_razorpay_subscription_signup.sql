-- Razorpay-gated signup with ₹2 verification + auto-renewal at trial end.
--
-- Flow:
--   1. User completes Supabase auth signup (password-based or OAuth).
--   2. Frontend submits org name + plan choice. We DON'T create the org yet.
--   3. Backend creates a Razorpay Subscription with:
--        - 14-day trial (start_at = now() + 14 days)
--        - ₹2 verification addon charged immediately on auth
--        - First real charge happens at start_at, then on every billing cycle.
--   4. Razorpay returns a subscription_id; frontend opens checkout for it.
--   5. On `subscription.authenticated` webhook → org + trial license are
--      created from the pending_signups row.
--   6. On `subscription.charged` webhook → license auto-renewed +1 cycle.
--   7. On `subscription.halted` webhook → org suspended.

-- ── Razorpay plan id on each TrackForce plan ───────────────────────────────
alter table public.plans
  add column if not exists razorpay_plan_id text;

comment on column public.plans.razorpay_plan_id is
  'Razorpay Plan ID (plan_xxx). Created once per plan via Razorpay dashboard or API. If null, this plan can''t be used for self-signup auto-billing.';

-- ── Subscription identifiers on organizations ──────────────────────────────
alter table public.organizations
  add column if not exists razorpay_subscription_id text,
  add column if not exists razorpay_customer_id    text,
  add column if not exists auth_payment_status     text default 'pending';

-- pending = initial state; authenticated = ₹2 captured & subscription active;
-- failed = auth attempt failed; cancelled = customer or admin halted.
alter table public.organizations
  drop constraint if exists organizations_auth_payment_status_check,
  add  constraint organizations_auth_payment_status_check
    check (auth_payment_status in ('pending','authenticated','failed','cancelled'));

-- ── pending_signups ────────────────────────────────────────────────────────
-- Holds form data + razorpay ids until the auth payment lands. Then the
-- webhook converts it to a real org via finalize_pending_signup().
create table if not exists public.pending_signups (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  org_name                 text not null,
  plan_id                  uuid not null references public.plans(id),
  phone                    text,
  country                  text default 'India',
  full_name                text,
  razorpay_subscription_id text,
  razorpay_customer_id     text,
  status                   text not null default 'pending',
  -- pending → razorpay_authenticated → completed
  -- (or → failed / cancelled)
  organization_id          uuid references public.organizations(id) on delete set null,
  created_at               timestamptz not null default now(),
  completed_at             timestamptz
);

create unique index if not exists pending_signups_user_pending_uniq
  on public.pending_signups(user_id) where status in ('pending','razorpay_authenticated');

create index if not exists pending_signups_subscription_idx
  on public.pending_signups(razorpay_subscription_id) where razorpay_subscription_id is not null;

alter table public.pending_signups enable row level security;

drop policy if exists pending_signups_self on public.pending_signups;
create policy pending_signups_self on public.pending_signups
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists pending_signups_super_admin on public.pending_signups;
create policy pending_signups_super_admin on public.pending_signups
  for select using (exists (select 1 from app_users where user_id = auth.uid() and app_role = 'super_admin'));

-- ── start_pending_signup RPC ───────────────────────────────────────────────
-- Called by the signup page after the user is authenticated. Stores form data
-- and returns a row id; the edge function reads this when creating the
-- Razorpay subscription.
create or replace function public.start_pending_signup(
  p_org_name text,
  p_plan_id  uuid,
  p_phone    text default null,
  p_country  text default 'India'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
  v_full_name text;
  v_existing_org uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if length(coalesce(trim(p_org_name),'')) = 0 then
    raise exception 'organization name required' using errcode = '22023';
  end if;

  -- Reject if user already owns an org — prevents accidental double signup.
  select id into v_existing_org from public.organizations where owner_user_id = v_uid limit 1;
  if v_existing_org is not null then
    raise exception 'this account already has an organization' using errcode = '23505';
  end if;

  if not exists (select 1 from public.plans where id = p_plan_id and is_active = true) then
    raise exception 'plan not found or inactive' using errcode = '22023';
  end if;

  select coalesce(raw_user_meta_data->>'full_name', email) into v_full_name
  from auth.users where id = v_uid;

  -- Replace any abandoned pending row for this user.
  delete from public.pending_signups
    where user_id = v_uid and status not in ('completed');

  insert into public.pending_signups (user_id, org_name, plan_id, phone, country, full_name)
  values (v_uid, p_org_name, p_plan_id, p_phone, p_country, v_full_name)
  returning id into v_id;

  return v_id;
end$$;

grant execute on function public.start_pending_signup(text, uuid, text, text) to authenticated;

-- ── finalize_pending_signup RPC ────────────────────────────────────────────
-- Called by the Razorpay webhook on `subscription.authenticated`. Creates the
-- organization + trial license and links them. Idempotent — running twice on
-- the same subscription is a no-op once the org exists.
create or replace function public.finalize_pending_signup(
  p_subscription_id text,
  p_customer_id     text default null
) returns table(organization_id uuid, license_id uuid, license_key text, trial_ends_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_pending  public.pending_signups%rowtype;
  v_org_id   uuid;
  v_lic_id   uuid;
  v_lic_key  text;
  v_seats    int;
  v_trial    timestamptz := now() + interval '14 days';
begin
  select * into v_pending from public.pending_signups
    where razorpay_subscription_id = p_subscription_id
    order by created_at desc limit 1;
  if not found then
    raise exception 'no pending signup for subscription %', p_subscription_id using errcode = 'P0002';
  end if;

  -- Idempotency: if we've already finalized this row, return the existing org.
  if v_pending.status = 'completed' and v_pending.organization_id is not null then
    return query
      select v_pending.organization_id,
             l.id, l.license_key, o.trial_ends_at
      from public.organizations o
      left join public.licenses l on l.organization_id = o.id
      where o.id = v_pending.organization_id
      order by l.issued_at desc nulls last
      limit 1;
    return;
  end if;

  select seat_count into v_seats from public.plans where id = v_pending.plan_id;

  insert into public.organizations (
    owner_user_id, name, phone, country,
    subscription_status, subscription_type,
    trial_ends_at, license_count,
    razorpay_subscription_id, razorpay_customer_id, auth_payment_status
  )
  values (
    v_pending.user_id, v_pending.org_name, v_pending.phone, v_pending.country,
    'trial', (select billing_cycle from public.plans where id = v_pending.plan_id),
    v_trial, v_seats,
    p_subscription_id, p_customer_id, 'authenticated'
  )
  returning id into v_org_id;

  insert into public.org_members (org_id, user_id, role, full_name)
  values (v_org_id, v_pending.user_id, 'owner', v_pending.full_name)
  on conflict (org_id, user_id) do nothing;

  insert into public.licenses (
    organization_id, plan_id, seat_count, status, issued_by, expires_at, notes
  )
  values (v_org_id, v_pending.plan_id, v_seats, 'active', v_pending.user_id, v_trial, 'Self-signup trial (Razorpay subscription)')
  returning id, licenses.license_key into v_lic_id, v_lic_key;

  update public.pending_signups
    set status = 'completed', organization_id = v_org_id, completed_at = now(),
        razorpay_customer_id = coalesce(razorpay_customer_id, p_customer_id)
    where id = v_pending.id;

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (v_pending.user_id, 'system', 'customer.razorpay_signup', 'organization', v_org_id,
          jsonb_build_object('subscription_id', p_subscription_id, 'plan_id', v_pending.plan_id));

  return query select v_org_id, v_lic_id, v_lic_key, v_trial;
end$$;

grant execute on function public.finalize_pending_signup(text, text) to service_role;

-- ── extend_subscription_charged RPC ────────────────────────────────────────
-- Webhook calls this on `subscription.charged`. Looks up the org by
-- razorpay_subscription_id and extends its license by one billing period.
create or replace function public.extend_subscription_charged(
  p_subscription_id text,
  p_payment_id      text default null,
  p_amount_paise    bigint default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org   public.organizations%rowtype;
  v_lic   public.licenses%rowtype;
  v_plan  public.plans%rowtype;
  v_new_exp timestamptz;
begin
  select * into v_org from public.organizations
    where razorpay_subscription_id = p_subscription_id;
  if not found then
    raise warning 'extend_subscription_charged: no org for subscription %', p_subscription_id;
    return;
  end if;

  select * into v_lic from public.licenses
    where organization_id = v_org.id
    order by issued_at desc limit 1;
  if not found then
    raise warning 'extend_subscription_charged: no license for org %', v_org.id;
    return;
  end if;

  select * into v_plan from public.plans where id = v_lic.plan_id;
  v_new_exp := case when v_plan.billing_cycle = 'yearly'
                    then greatest(v_lic.expires_at, now()) + interval '1 year'
                    else greatest(v_lic.expires_at, now()) + interval '1 month'
                end;

  update public.licenses
    set status = 'active', expires_at = v_new_exp
    where id = v_lic.id;

  update public.organizations
    set subscription_status = 'active'
    where id = v_org.id and subscription_status in ('trial','expired','suspended');

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (null, 'system', 'subscription.charged', 'license', v_lic.id,
          jsonb_build_object(
            'subscription_id', p_subscription_id,
            'payment_id', p_payment_id,
            'amount_paise', p_amount_paise,
            'new_expires_at', v_new_exp
          ));
end$$;

grant execute on function public.extend_subscription_charged(text, text, bigint) to service_role;

-- ── halt_subscription RPC (for subscription.halted/cancelled events) ───────
create or replace function public.halt_subscription(
  p_subscription_id text,
  p_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_org_id uuid;
begin
  select id into v_org_id from public.organizations where razorpay_subscription_id = p_subscription_id;
  if v_org_id is null then return; end if;

  update public.organizations
    set subscription_status = 'suspended', auth_payment_status = 'cancelled'
    where id = v_org_id;

  update public.licenses
    set status = 'suspended'
    where organization_id = v_org_id and status = 'active';

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (null, 'system', 'subscription.halted', 'organization', v_org_id,
          jsonb_build_object('subscription_id', p_subscription_id, 'reason', p_reason));
end$$;

grant execute on function public.halt_subscription(text, text) to service_role;
