-- 0029_offboarding.sql
-- 3-stage offboarding workflow.
--   stage 1: creds_review  — IT receives full list of creds ever issued to this employee.
--   stage 2: access_revoked — IT verifies stage 1, system blocks sign-in on M365/Google.
--   stage 3: completed     — IT records laptop handover + remark, HR + Accounts get final mail.

create table if not exists public.offboardings (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  employee_id          uuid not null references public.employees(id) on delete cascade,

  initiated_by         uuid references auth.users(id) on delete set null,
  initiated_at         timestamptz not null default now(),
  reason               text,
  lwd                  date,                                 -- last working day

  current_stage        text not null default 'creds_review'
                         check (current_stage in ('creds_review','access_revoked','completed')),
  status               text not null default 'in_progress'
                         check (status in ('in_progress','cancelled','done')),

  stage1_completed_at  timestamptz,
  stage1_it_recipients text[] not null default '{}',         -- captured when stage 1 mail goes out

  stage2_completed_at  timestamptz,
  stage2_signin_blocked_at timestamptz,
  stage2_block_detail  jsonb not null default '{}'::jsonb,   -- {m365: {ok, error?}, google: {...}}

  stage3_completed_at  timestamptz,
  laptop_serial        text,
  asset_notes          text,
  it_remark            text,
  stage3_hr_recipients       text[] not null default '{}',
  stage3_accounts_recipients text[] not null default '{}',

  cancelled_at         timestamptz,
  cancelled_reason     text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Enforce: at most one in_progress offboarding per employee.
drop index if exists offboardings_one_active_idx;
create unique index offboardings_one_active_idx
  on public.offboardings(employee_id)
  where status = 'in_progress';

create index if not exists offboardings_org_idx           on public.offboardings(org_id, created_at desc);
create index if not exists offboardings_stage_idx         on public.offboardings(org_id, current_stage) where status = 'in_progress';

create or replace function public.touch_offboardings_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_offboardings_touch on public.offboardings;
create trigger trg_offboardings_touch before update on public.offboardings
  for each row execute function public.touch_offboardings_updated_at();

-- ============== offboarding_events ==============
create table if not exists public.offboarding_events (
  id             uuid primary key default gen_random_uuid(),
  offboarding_id uuid not null references public.offboardings(id) on delete cascade,
  org_id         uuid not null,
  actor_id       uuid references auth.users(id) on delete set null,
  event          text not null,         -- started | creds_mail_sent | signin_blocked | block_failed | completed | cancelled
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists offboarding_events_off_idx on public.offboarding_events(offboarding_id, created_at);

-- ============== v_employee_cred_history ==============
-- The "everything ever sent to this user" list used in stage 1 + stage 3 mails.
create or replace view public.v_employee_cred_history as
  select
    a.org_id,
    a.employee_id,
    a.id           as assignment_id,
    a.credential_id,
    c.platform_name,
    c.category,
    c.login_url,
    c.username,
    a.delivery_email,
    a.sent_at,
    a.sent_by,
    a.request_id,
    a.revoked_at,
    a.revoked_reason
  from public.credential_assignments a
  join public.credentials c on c.id = a.credential_id;

-- ============== RLS ==============
alter table public.offboardings        enable row level security;
alter table public.offboarding_events  enable row level security;

drop policy if exists offboardings_select on public.offboardings;
create policy offboardings_select on public.offboardings
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists offboardings_write on public.offboardings;
create policy offboardings_write on public.offboardings
  for all using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));

drop policy if exists offboarding_events_select on public.offboarding_events;
create policy offboarding_events_select on public.offboarding_events
  for select using (org_id in (select public.user_org_ids()));
