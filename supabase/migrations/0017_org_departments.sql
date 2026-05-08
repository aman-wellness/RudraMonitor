-- 0017_org_departments.sql
-- Per-org department list. Used to categorise agents (Sales / Engineering / Support …).
-- Currently `agents.department` is a free-text column; over time agents should
-- reference org_departments.name (or a FK), but we leave that migration for later
-- to avoid breaking existing rows. The table here is the source of truth for the
-- dropdown the admin portal will offer.

create table if not exists public.org_departments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null,
  description text,
  agent_count int not null default 0,        -- denormalised; refreshed via trigger below
  color       text,                          -- optional UI tint, e.g. 'emerald', 'cyan'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, name)
);

create index if not exists org_departments_org_idx on public.org_departments(org_id);

-- Auto-bump updated_at on edit
create or replace function public.touch_org_departments_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_org_departments_touch on public.org_departments;
create trigger trg_org_departments_touch
  before update on public.org_departments
  for each row execute function public.touch_org_departments_updated_at();

-- Live agent_count maintenance: when agents.department changes, recalc the relevant rows
create or replace function public.refresh_dept_agent_count(p_org uuid, p_dept text)
returns void language sql as $$
  update public.org_departments d
    set agent_count = (
      select count(*) from public.agents a
       where a.org_id = p_org
         and lower(coalesce(a.department, '')) = lower(coalesce(p_dept, ''))
    )
    where d.org_id = p_org and lower(d.name) = lower(coalesce(p_dept, ''));
$$;

create or replace function public.handle_agent_dept_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform public.refresh_dept_agent_count(new.org_id, new.department);
  elsif tg_op = 'UPDATE' then
    if (old.department is distinct from new.department) or (old.org_id is distinct from new.org_id) then
      perform public.refresh_dept_agent_count(old.org_id, old.department);
      perform public.refresh_dept_agent_count(new.org_id, new.department);
    end if;
  elsif tg_op = 'DELETE' then
    perform public.refresh_dept_agent_count(old.org_id, old.department);
  end if;
  return null;
end $$;

drop trigger if exists trg_agents_dept_count on public.agents;
create trigger trg_agents_dept_count
  after insert or update of department, org_id or delete on public.agents
  for each row execute function public.handle_agent_dept_change();

------------------------------------------------------------
-- RLS
------------------------------------------------------------
alter table public.org_departments enable row level security;

-- Org members can read their own org's departments
drop policy if exists org_departments_member_read on public.org_departments;
create policy org_departments_member_read on public.org_departments for select
  using (exists (
    select 1 from public.org_members m
    where m.org_id = org_departments.org_id and m.user_id = auth.uid()
  ));

-- Org owner / admin can write
drop policy if exists org_departments_admin_write on public.org_departments;
create policy org_departments_admin_write on public.org_departments for all
  using (exists (
    select 1 from public.org_members m
    where m.org_id = org_departments.org_id
      and m.user_id = auth.uid()
      and m.role in ('owner','admin')
  ))
  with check (exists (
    select 1 from public.org_members m
    where m.org_id = org_departments.org_id
      and m.user_id = auth.uid()
      and m.role in ('owner','admin')
  ));

-- Super-admin always has access
drop policy if exists org_departments_super_all on public.org_departments;
create policy org_departments_super_all on public.org_departments for all
  using (public.is_super_admin())
  with check (public.is_super_admin());
