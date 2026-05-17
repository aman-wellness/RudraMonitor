-- 0047_plan_upgrade_requests.sql
-- Customer-initiated plan upgrade requests. Customer clicks "Select & Upgrade"
-- in /admin-portal → Subscription, we record the request here, and super admin
-- sees it in customer detail. Approval flips the active license's plan_id.
--
-- Live Razorpay billing wires into this same table later: the request will
-- create a Razorpay subscription, status flips to 'paid' on webhook, and the
-- license switches automatically. For now it's manual approval.

create table if not exists public.plan_upgrade_requests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  plan_id       uuid not null references public.plans(id) on delete restrict,
  requested_by  uuid references auth.users(id) on delete set null,
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','cancelled')),
  note          text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references auth.users(id) on delete set null
);

create index if not exists plan_upgrade_requests_org_idx
  on public.plan_upgrade_requests(org_id, status, created_at desc);

alter table public.plan_upgrade_requests enable row level security;

-- Org members can see / create their own org's requests.
drop policy if exists pur_org_select on public.plan_upgrade_requests;
create policy pur_org_select on public.plan_upgrade_requests
  for select using (
    exists(select 1 from public.org_members m where m.org_id = plan_upgrade_requests.org_id and m.user_id = auth.uid())
  );

drop policy if exists pur_org_insert on public.plan_upgrade_requests;
create policy pur_org_insert on public.plan_upgrade_requests
  for insert with check (
    exists(select 1 from public.org_members m where m.org_id = plan_upgrade_requests.org_id and m.user_id = auth.uid())
  );

-- Cancellation only by the requester or org owner.
drop policy if exists pur_org_cancel on public.plan_upgrade_requests;
create policy pur_org_cancel on public.plan_upgrade_requests
  for update using (
    plan_upgrade_requests.requested_by = auth.uid()
    or exists(select 1 from public.organizations o where o.id = plan_upgrade_requests.org_id and o.owner_user_id = auth.uid())
  );

-- Super admin sees + decides everything.
drop policy if exists pur_admin_all on public.plan_upgrade_requests;
create policy pur_admin_all on public.plan_upgrade_requests
  for all using (
    exists(select 1 from public.app_users a where a.user_id = auth.uid() and a.app_role = 'super_admin')
  );

comment on table public.plan_upgrade_requests is
  'Customer-initiated upgrade requests. Super admin approves → license plan_id is switched.';
