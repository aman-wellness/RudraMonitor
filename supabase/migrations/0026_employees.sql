-- 0026_employees.sql
-- Employee lifecycle table. Distinct from `org_members` (portal logins) and
-- `agents` (desktop machines). One employee = one human; may own zero or many
-- agents and may or may not have a portal login. M365 / Google identifiers are
-- captured here once provisioned by Feature 1.

create table if not exists public.employees (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,

  full_name         text not null,
  personal_email    text,
  work_email        text,                                  -- UPN once provisioned
  employee_code     text,                                  -- HR-side code, optional
  designation       text,
  department_id     uuid references public.org_departments(id) on delete set null,
  manager_id        uuid references public.employees(id) on delete set null,

  doj               date,                                  -- date of joining
  lwd               date,                                  -- last working day (set on offboarding)
  status            text not null default 'active',        -- active | offboarding | offboarded
  source            text not null default 'rudrans_created', -- rudrans_created | imported

  -- External directory identifiers (filled by provisioning / sync)
  m365_user_id      text,                                  -- Graph user.id
  google_user_id    text,                                  -- Google directory id
  m365_license_skus jsonb not null default '[]'::jsonb,    -- ["ENTERPRISEPACK", ...]

  -- Lifecycle metadata
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (org_id, work_email),
  unique (org_id, employee_code)
);

create index if not exists employees_org_idx        on public.employees(org_id);
create index if not exists employees_dept_idx       on public.employees(department_id);
create index if not exists employees_manager_idx    on public.employees(manager_id);
create index if not exists employees_status_idx     on public.employees(org_id, status);
create index if not exists employees_m365_idx       on public.employees(org_id, m365_user_id);
create index if not exists employees_google_idx     on public.employees(org_id, google_user_id);

create or replace function public.touch_employees_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

drop trigger if exists trg_employees_touch on public.employees;
create trigger trg_employees_touch before update on public.employees
  for each row execute function public.touch_employees_updated_at();

-- ============== employee_audit ==============
-- Append-only audit of every provisioning / lifecycle action.
create table if not exists public.employee_audit (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  actor_id    uuid references auth.users(id) on delete set null,
  action      text not null,         -- created | provisioned_m365 | provisioned_google
                                     -- | password_reset | license_assigned | license_removed
                                     -- | group_added | group_removed | blocked | unblocked
                                     -- | offboarding_started | offboarding_completed | deleted
  target      text,                  -- free text (e.g. group name, license SKU)
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists employee_audit_org_time_idx      on public.employee_audit(org_id, created_at desc);
create index if not exists employee_audit_employee_time_idx on public.employee_audit(employee_id, created_at desc);

-- ============== RLS ==============
alter table public.employees      enable row level security;
alter table public.employee_audit enable row level security;

drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists employees_write on public.employees;
create policy employees_write on public.employees
  for all using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));

drop policy if exists employee_audit_select on public.employee_audit;
create policy employee_audit_select on public.employee_audit
  for select using (org_id in (select public.user_org_ids()));
-- Writes to employee_audit happen via service-role (edge functions) only.
