-- 0013_partners_billing.sql
-- Multi-tenant: super-admin + partner + customer portals.
-- Adds: app_users (role gate), partners, partner_members, plans, licenses, invoices, audit_log.

------------------------------------------------------------
-- 1. App-role gate
------------------------------------------------------------
create table if not exists public.app_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  app_role   text not null check (app_role in ('super_admin','partner','customer')),
  partner_id uuid,                                  -- set if app_role='partner'
  created_at timestamptz not null default now()
);

create index if not exists app_users_role_idx on public.app_users(app_role);

-- Backfill: every existing auth user → customer (super-admin promoted manually below)
insert into public.app_users (user_id, app_role)
select id, 'customer' from auth.users
on conflict (user_id) do nothing;

-- Auto-create app_users on signup. If the new email matches an *active* partner,
-- promote to 'partner' and link partner_id; otherwise default to 'customer'.
create or replace function public.handle_new_user_role()
returns trigger language plpgsql security definer as $$
declare
  matched_partner uuid;
begin
  select id into matched_partner
  from public.partners
  where lower(contact_email) = lower(new.email) and status = 'active'
  limit 1;

  if matched_partner is not null then
    insert into public.app_users (user_id, app_role, partner_id)
    values (new.id, 'partner', matched_partner)
    on conflict (user_id) do update
      set app_role = 'partner', partner_id = matched_partner;

    insert into public.partner_members (partner_id, user_id, role, email, full_name)
    values (matched_partner, new.id, 'admin', new.email, new.raw_user_meta_data->>'partner_name')
    on conflict (partner_id, user_id) do nothing;
  else
    insert into public.app_users (user_id, app_role)
    values (new.id, 'customer')
    on conflict (user_id) do nothing;
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created_role on auth.users;
create trigger on_auth_user_created_role
  after insert on auth.users
  for each row execute function public.handle_new_user_role();

------------------------------------------------------------
-- 2. Partners (resellers)
------------------------------------------------------------
create table if not exists public.partners (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  contact_email   text not null unique,
  phone           text,
  gst_number      text,
  address         text,
  city            text,
  state           text,
  country         text default 'India',
  status          text not null default 'pending'
                   check (status in ('pending','active','suspended','rejected')),
  commission_pct  numeric(5,2) not null default 20.00,    -- e.g. 20.00 = 20%
  approved_by     uuid references auth.users(id),
  approved_at     timestamptz,
  rejection_reason text,
  created_at      timestamptz not null default now()
);

create index if not exists partners_status_idx on public.partners(status);

-- Now that partners exists, set FK on app_users.partner_id
alter table public.app_users
  drop constraint if exists app_users_partner_id_fkey;
alter table public.app_users
  add constraint app_users_partner_id_fkey
  foreign key (partner_id) references public.partners(id) on delete set null;

-- Partner staff (multiple users per partner)
create table if not exists public.partner_members (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references public.partners(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'admin' check (role in ('admin','staff')),
  full_name   text,
  email       text,
  created_at  timestamptz not null default now(),
  unique (partner_id, user_id)
);

create index if not exists partner_members_user_idx on public.partner_members(user_id);
create index if not exists partner_members_partner_idx on public.partner_members(partner_id);

------------------------------------------------------------
-- 3. Plans (catalog)
------------------------------------------------------------
create table if not exists public.plans (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,           -- e.g. 'basic-5', 'pro-25'
  name           text not null,
  description    text,
  seat_count     int not null check (seat_count > 0),
  price_inr      numeric(10,2) not null check (price_inr >= 0),
  billing_cycle  text not null default 'yearly' check (billing_cycle in ('monthly','yearly')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Seed a few default plans (admin can add more)
insert into public.plans (code, name, seat_count, price_inr, billing_cycle) values
  ('starter-5',   'Starter (5 seats)',     5,   12000, 'yearly'),
  ('growth-25',   'Growth (25 seats)',     25,  54000, 'yearly'),
  ('scale-100',   'Scale (100 seats)',     100, 180000,'yearly')
on conflict (code) do nothing;

------------------------------------------------------------
-- 4. Link organizations to partner
------------------------------------------------------------
alter table public.organizations
  add column if not exists partner_id uuid references public.partners(id) on delete set null;

create index if not exists organizations_partner_idx on public.organizations(partner_id);

------------------------------------------------------------
-- 5. Licenses
------------------------------------------------------------
create table if not exists public.licenses (
  id                uuid primary key default gen_random_uuid(),
  license_key       text not null unique default replace(gen_random_uuid()::text,'-',''),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  partner_id        uuid references public.partners(id) on delete set null,
  plan_id           uuid not null references public.plans(id),
  seat_count        int  not null check (seat_count > 0),
  status            text not null default 'active'
                     check (status in ('active','suspended','expired','revoked')),
  issued_by         uuid references auth.users(id),
  issued_at         timestamptz not null default now(),
  expires_at        timestamptz not null,        -- 1y from issue for yearly plans
  revoked_at        timestamptz,
  revoke_reason     text,
  notes             text,
  created_at        timestamptz not null default now()
);

create index if not exists licenses_org_idx     on public.licenses(organization_id);
create index if not exists licenses_partner_idx on public.licenses(partner_id);
create index if not exists licenses_status_idx  on public.licenses(status);
create index if not exists licenses_key_idx     on public.licenses(license_key);

------------------------------------------------------------
-- 6. Invoices
------------------------------------------------------------
create table if not exists public.invoices (
  id                  uuid primary key default gen_random_uuid(),
  invoice_number      text not null unique,        -- e.g. 'TF-2026-0001'
  organization_id     uuid not null references public.organizations(id) on delete restrict,
  partner_id          uuid references public.partners(id) on delete set null,
  license_id          uuid references public.licenses(id) on delete set null,
  plan_id             uuid references public.plans(id),
  amount_inr          numeric(10,2) not null,
  gst_pct             numeric(5,2) not null default 18.00,
  gst_amount_inr      numeric(10,2) not null,
  total_inr           numeric(10,2) not null,
  partner_commission_inr numeric(10,2) not null default 0,
  status              text not null default 'pending'
                       check (status in ('pending','paid','failed','refunded','cancelled')),
  razorpay_order_id   text,
  razorpay_payment_id text,
  issued_at           timestamptz not null default now(),
  due_at              timestamptz,
  paid_at             timestamptz,
  notes               text,
  created_at          timestamptz not null default now()
);

create index if not exists invoices_org_idx     on public.invoices(organization_id);
create index if not exists invoices_partner_idx on public.invoices(partner_id);
create index if not exists invoices_status_idx  on public.invoices(status);

-- Sequence-backed invoice number
create sequence if not exists public.invoice_number_seq start 1;

create or replace function public.next_invoice_number()
returns text language sql as $$
  select 'TF-' || to_char(now(),'YYYY') || '-' || lpad(nextval('public.invoice_number_seq')::text,5,'0');
$$;

------------------------------------------------------------
-- 7. Audit log (super-admin / partner actions)
------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigint generated by default as identity primary key,
  actor_user  uuid references auth.users(id) on delete set null,
  actor_role  text,                                -- snapshot: super_admin/partner/customer
  action      text not null,                       -- e.g. 'partner.approve', 'license.revoke'
  target_type text,                                -- 'partner' | 'organization' | 'license' | 'invoice'
  target_id   uuid,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_actor_idx  on public.audit_log(actor_user);
create index if not exists audit_log_target_idx on public.audit_log(target_type, target_id);
create index if not exists audit_log_created_idx on public.audit_log(created_at desc);

------------------------------------------------------------
-- 8. RLS
------------------------------------------------------------
alter table public.app_users        enable row level security;
alter table public.partners         enable row level security;
alter table public.partner_members  enable row level security;
alter table public.plans            enable row level security;
alter table public.licenses         enable row level security;
alter table public.invoices         enable row level security;
alter table public.audit_log        enable row level security;

-- Helper: is current user super_admin?
create or replace function public.is_super_admin()
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.app_users
    where user_id = auth.uid() and app_role = 'super_admin'
  );
$$;

-- Helper: current user's partner_id (null if not a partner)
create or replace function public.current_partner_id()
returns uuid language sql stable security definer as $$
  select partner_id from public.app_users where user_id = auth.uid();
$$;

-- app_users: user can read own row; super_admin reads all
drop policy if exists app_users_self_read on public.app_users;
create policy app_users_self_read on public.app_users for select
  using (user_id = auth.uid() or public.is_super_admin());

drop policy if exists app_users_super_write on public.app_users;
create policy app_users_super_write on public.app_users for all
  using (public.is_super_admin()) with check (public.is_super_admin());

-- partners: super_admin all; partner_members read own partner
drop policy if exists partners_super_all on public.partners;
create policy partners_super_all on public.partners for all
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists partners_self_read on public.partners;
create policy partners_self_read on public.partners for select
  using (id = public.current_partner_id());

-- Public partner signup: anyone can insert a 'pending' application
drop policy if exists partners_public_signup on public.partners;
create policy partners_public_signup on public.partners for insert
  with check (status = 'pending');

-- partner_members: super_admin all; partner staff read own partner
drop policy if exists partner_members_super_all on public.partner_members;
create policy partner_members_super_all on public.partner_members for all
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists partner_members_self_read on public.partner_members;
create policy partner_members_self_read on public.partner_members for select
  using (partner_id = public.current_partner_id() or user_id = auth.uid());

-- plans: anyone authenticated can read active plans; super_admin writes
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select using (auth.role() = 'authenticated');

drop policy if exists plans_super_write on public.plans;
create policy plans_super_write on public.plans for all
  using (public.is_super_admin()) with check (public.is_super_admin());

-- licenses: super_admin all; partner sees own-partner licenses; org members read own org
drop policy if exists licenses_super_all on public.licenses;
create policy licenses_super_all on public.licenses for all
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists licenses_partner_read on public.licenses;
create policy licenses_partner_read on public.licenses for select
  using (partner_id is not null and partner_id = public.current_partner_id());

drop policy if exists licenses_org_read on public.licenses;
create policy licenses_org_read on public.licenses for select
  using (exists (
    select 1 from public.org_members m
    where m.org_id = licenses.organization_id and m.user_id = auth.uid()
  ));

-- invoices: same pattern as licenses
drop policy if exists invoices_super_all on public.invoices;
create policy invoices_super_all on public.invoices for all
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists invoices_partner_read on public.invoices;
create policy invoices_partner_read on public.invoices for select
  using (partner_id is not null and partner_id = public.current_partner_id());

drop policy if exists invoices_org_read on public.invoices;
create policy invoices_org_read on public.invoices for select
  using (exists (
    select 1 from public.org_members m
    where m.org_id = invoices.organization_id and m.user_id = auth.uid()
  ));

-- audit_log: super_admin only
drop policy if exists audit_log_super_only on public.audit_log;
create policy audit_log_super_only on public.audit_log for all
  using (public.is_super_admin()) with check (public.is_super_admin());

------------------------------------------------------------
-- 9. Bootstrap super-admin (run manually once after migration)
------------------------------------------------------------
-- Replace email below with your super-admin email and run in SQL editor:
--
--   update public.app_users
--   set app_role = 'super_admin', partner_id = null
--   where user_id = (select id from auth.users where email = 'aman@wellnessextract.com');

------------------------------------------------------------
-- Done.
------------------------------------------------------------
