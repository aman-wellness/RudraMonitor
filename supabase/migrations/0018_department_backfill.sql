-- 0018_department_backfill.sql
-- Two improvements to org_departments:
--   1. Backfill: any free-text department already on agents.department gets a row
--      in org_departments so it shows up (and can be edited/deleted) in the admin UI.
--   2. Future-proof: when a NEW org_departments row is inserted, compute its
--      agent_count immediately. Previously the count only updated when an agent's
--      department field changed, leaving newly-created rows at 0.

-- 1. Backfill — one-time, idempotent.
insert into public.org_departments (org_id, name)
select distinct org_id, trim(department)
  from public.agents
  where department is not null
    and trim(department) <> ''
    and trim(department) <> 'Unassigned'
on conflict (org_id, name) do nothing;

-- Refresh counts for ALL departments (not just freshly-inserted ones — covers prior runs)
update public.org_departments d
  set agent_count = (
    select count(*) from public.agents a
     where a.org_id = d.org_id
       and lower(coalesce(a.department, '')) = lower(d.name)
  );

-- 2. Future-proof: BEFORE INSERT trigger seeds the count for new rows
create or replace function public.handle_new_department()
returns trigger language plpgsql as $$
begin
  new.agent_count := (
    select count(*) from public.agents a
     where a.org_id = new.org_id
       and lower(coalesce(a.department, '')) = lower(new.name)
  );
  return new;
end $$;

drop trigger if exists trg_org_departments_initial_count on public.org_departments;
create trigger trg_org_departments_initial_count
  before insert on public.org_departments
  for each row execute function public.handle_new_department();
