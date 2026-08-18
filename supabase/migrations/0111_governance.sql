-- 0111_governance.sql
-- Access & Communication Governance tool.
--
-- Mirrors the static `we_governance_v1.0_FINAL.html` document (Rudrans
-- internal, v1.0 June 2026) as a live, multi-tenant, editable feature at
-- /governance. Every customer org gets their own pillar/channel/policy setup.
--
-- 8 tables:
--   gov_pillars              — the functional pillars (SEO, Paid Media, …)
--   gov_pillar_assignments   — who has what role on which pillar
--   gov_pillar_platforms     — platforms (Semrush, Amazon, …) per pillar
--   gov_channels             — Slack/Teams channels (documentation only)
--   gov_channel_members      — channel membership
--   gov_access_register      — per-platform individual access tracker
--   gov_policies             — numbered P01–P08 policies
--   gov_audit_events         — append-only audit log
--
-- All RLS-scoped by org_id. Writes gated on public.is_org_writer(org_id) from
-- migration 0055. Reads visible to any org_member.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_type where typname = 'gov_role') then
    create type public.gov_role as enum ('owner','admin','editor','view','external');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'gov_pillar_status') then
    create type public.gov_pillar_status as enum ('filled','hiring','vacant','archived');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'gov_channel_layer') then
    create type public.gov_channel_layer as enum ('L1','L2','L3');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'gov_member_type') then
    create type public.gov_member_type as enum ('member','guest','external');
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- gov_pillars
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.gov_pillars (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations(id) on delete cascade,
  code                     text not null,                            -- slug: 'seo', 'paid-media'
  name                     text not null,                            -- 'SEO', 'Paid Media'
  color                    text not null default '#444444',          -- hex like '#2563a8'
  functions_desc           text,                                     -- 'Organic search · Technical SEO · …'
  reports_to_pillar_id     uuid references public.gov_pillars(id) on delete set null,
  hiring_flag              boolean not null default false,           -- lead seat open
  status                   public.gov_pillar_status not null default 'filled',
  sort_order               int not null default 100,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (org_id, code)
);

create index if not exists gov_pillars_org_sort_idx on public.gov_pillars(org_id, sort_order);

create or replace function public.touch_gov_pillars()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_gov_pillars_touch on public.gov_pillars;
create trigger trg_gov_pillars_touch before update on public.gov_pillars
  for each row execute function public.touch_gov_pillars();

-- ─────────────────────────────────────────────────────────────────────────────
-- gov_pillar_assignments — role assignments per pillar
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.gov_pillar_assignments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  pillar_id     uuid not null references public.gov_pillars(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  role          public.gov_role not null,                            -- owner / admin / editor / view / external
  is_acting     boolean not null default false,                      -- temp filler until permanent hire
  notes         text,
  created_at    timestamptz not null default now(),
  unique (pillar_id, employee_id, role)
);

create index if not exists gov_pillar_assignments_org_idx     on public.gov_pillar_assignments(org_id);
create index if not exists gov_pillar_assignments_pillar_idx  on public.gov_pillar_assignments(pillar_id);
create index if not exists gov_pillar_assignments_emp_idx     on public.gov_pillar_assignments(employee_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- gov_pillar_platforms — platforms owned by each pillar
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.gov_pillar_platforms (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  pillar_id       uuid not null references public.gov_pillars(id) on delete cascade,
  platform_name   text not null,                                     -- 'Semrush', 'Amazon Seller Central'
  platform_type   text,                                              -- 'SEO Suite', 'Marketplace'
  access_method   text,                                              -- 'Direct + Agency MCC link'
  ownership_email text,                                              -- 'amazon@wellnessextract.com'
  it_registered   boolean not null default false,
  credential_id   uuid references public.credentials(id) on delete set null,  -- optional link to vault
  notes           text,
  sort_order      int not null default 100,
  created_at      timestamptz not null default now()
);

create index if not exists gov_pillar_platforms_org_idx    on public.gov_pillar_platforms(org_id);
create index if not exists gov_pillar_platforms_pillar_idx on public.gov_pillar_platforms(pillar_id, sort_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- gov_channels — Slack/Teams channels (documentation; not synced to external)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.gov_channels (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  layer               public.gov_channel_layer not null default 'L2',
  name                text not null,                                 -- '#seo' (include the #)
  purpose             text,
  parent_channel_id   uuid references public.gov_channels(id) on delete set null,
  primary_pillar_id   uuid references public.gov_pillars(id) on delete set null,
  sort_order          int not null default 100,
  created_at          timestamptz not null default now(),
  unique (org_id, name)
);

create index if not exists gov_channels_org_idx on public.gov_channels(org_id, layer, sort_order);

create table if not exists public.gov_channel_members (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  channel_id   uuid not null references public.gov_channels(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  member_type  public.gov_member_type not null default 'member',
  created_at   timestamptz not null default now(),
  unique (channel_id, employee_id)
);

create index if not exists gov_channel_members_channel_idx on public.gov_channel_members(channel_id);
create index if not exists gov_channel_members_emp_idx     on public.gov_channel_members(employee_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- gov_access_register — per-platform individual access tracker (Section 5)
-- employee_id NULL = vacant seat (e.g. 'Marketplaces Lead: Hiring')
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.gov_access_register (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  platform_id         uuid not null references public.gov_pillar_platforms(id) on delete cascade,
  employee_id         uuid references public.employees(id) on delete set null,
  role_label          text not null,                                 -- 'Marketplaces Lead', 'Founder', 'Agency'
  email_format        text,                                          -- 'jomin@wellnessextract.com', 'MCC Link ID'
  access_level        public.gov_role not null,
  last_reviewed_at    timestamptz,
  last_reviewed_by    uuid references auth.users(id) on delete set null,
  notes               text,
  sort_order          int not null default 100,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists gov_access_register_org_idx       on public.gov_access_register(org_id);
create index if not exists gov_access_register_platform_idx  on public.gov_access_register(platform_id, sort_order);
create index if not exists gov_access_register_review_idx    on public.gov_access_register(org_id, last_reviewed_at);

create or replace function public.touch_gov_access_register()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_gov_access_register_touch on public.gov_access_register;
create trigger trg_gov_access_register_touch before update on public.gov_access_register
  for each row execute function public.touch_gov_access_register();

-- ─────────────────────────────────────────────────────────────────────────────
-- gov_policies — P01..P08 numbered policy list (Section 6)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.gov_policies (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  code          text not null,                                       -- 'P01'
  body          text not null,
  enforced_by   text,                                                -- 'IT', 'Founder'
  sort_order    int not null default 100,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, code)
);

create index if not exists gov_policies_org_idx on public.gov_policies(org_id, sort_order);

create or replace function public.touch_gov_policies()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_gov_policies_touch on public.gov_policies;
create trigger trg_gov_policies_touch before update on public.gov_policies
  for each row execute function public.touch_gov_policies();

-- ─────────────────────────────────────────────────────────────────────────────
-- gov_audit_events — append-only audit log
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.gov_audit_events (
  id            bigserial primary key,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  actor_id      uuid references auth.users(id) on delete set null,
  entity_type   text not null,    -- 'pillar', 'assignment', 'platform', 'channel', 'access_register', 'policy'
  entity_id     uuid,
  action        text not null,    -- 'create', 'update', 'delete', 'review', 'seed'
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists gov_audit_org_idx on public.gov_audit_events(org_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS  —  reads scoped per org_member; writes gated on is_org_writer().
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.gov_pillars              enable row level security;
alter table public.gov_pillar_assignments   enable row level security;
alter table public.gov_pillar_platforms     enable row level security;
alter table public.gov_channels             enable row level security;
alter table public.gov_channel_members      enable row level security;
alter table public.gov_access_register      enable row level security;
alter table public.gov_policies             enable row level security;
alter table public.gov_audit_events         enable row level security;

-- Helper: is the caller a member of this org?
create or replace function public.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members
     where org_id = p_org and user_id = auth.uid()
  )
$$;
grant execute on function public.is_org_member(uuid) to authenticated;

-- Generic policy template: SELECT for members, INSERT/UPDATE/DELETE for writers.
do $$
declare t text;
begin
  foreach t in array array[
    'gov_pillars','gov_pillar_assignments','gov_pillar_platforms',
    'gov_channels','gov_channel_members','gov_access_register','gov_policies'
  ]
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select using (public.is_org_member(org_id))',
      t, t
    );
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert with check (public.is_org_writer(org_id))',
      t, t
    );
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update using (public.is_org_writer(org_id)) with check (public.is_org_writer(org_id))',
      t, t
    );
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format(
      'create policy %I_delete on public.%I for delete using (public.is_org_writer(org_id))',
      t, t
    );
  end loop;
end $$;

-- Audit log: SELECT for members, INSERTs only via SECURITY DEFINER function below.
-- No direct INSERT/UPDATE/DELETE policy → all attempts blocked.
drop policy if exists gov_audit_events_select on public.gov_audit_events;
create policy gov_audit_events_select on public.gov_audit_events
  for select using (public.is_org_member(org_id));

-- Append-only audit writer; callable from any authenticated user but always
-- writes their own uid as actor.
create or replace function public.gov_log_audit(
  p_org_id      uuid,
  p_entity_type text,
  p_entity_id   uuid,
  p_action      text,
  p_detail      jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Caller must be a member of the org.
  if not public.is_org_member(p_org_id) then
    raise exception 'not authorized';
  end if;
  insert into public.gov_audit_events (org_id, actor_id, entity_type, entity_id, action, detail)
  values (p_org_id, auth.uid(), p_entity_type, p_entity_id, p_action, coalesce(p_detail, '{}'::jsonb));
end$$;

revoke all on function public.gov_log_audit(uuid, text, uuid, text, jsonb) from public;
grant execute on function public.gov_log_audit(uuid, text, uuid, text, jsonb) to authenticated;
grant execute on function public.gov_log_audit(uuid, text, uuid, text, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed function — gov_seed_default_pillars
--
-- Idempotent: skips if the org already has any pillars OR policies. Inserts
-- the 9 default pillars + 8 default policies from the v1 governance doc so
-- every new customer starts with a working skeleton instead of a blank page.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.gov_seed_default_pillars(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing_pillars int;
  v_existing_policies int;
  v_inserted_pillars int := 0;
  v_inserted_policies int := 0;
begin
  -- Authz: caller must be a writer (owner/admin) of this org.
  if not public.is_org_writer(p_org_id) then
    raise exception 'not authorized — owner/admin only';
  end if;

  select count(*) into v_existing_pillars  from public.gov_pillars  where org_id = p_org_id;
  select count(*) into v_existing_policies from public.gov_policies where org_id = p_org_id;

  -- Pillars (only if none exist for this org)
  if v_existing_pillars = 0 then
    insert into public.gov_pillars (org_id, code, name, color, functions_desc, sort_order, hiring_flag, status) values
      (p_org_id, 'seo',           'SEO',                   '#2563a8', 'Organic search · Technical SEO · Content strategy',     10, false, 'filled'),
      (p_org_id, 'paid-media',    'Paid Media',            '#8a5c0e', 'Google Ads · Meta · Agency managed',                    20, true,  'hiring'),
      (p_org_id, 'marketplaces',  'Marketplaces',          '#5535a0', 'Amazon Seller Central · Walmart Seller Center',         30, true,  'hiring'),
      (p_org_id, 'retention',     'Retention',             '#176044', 'Email · SMS · Lifecycle automation',                    40, true,  'hiring'),
      (p_org_id, 'content',       'Content',               '#155e6b', 'Copywriting · Blogs · Product content · Briefs',        50, false, 'filled'),
      (p_org_id, 'ecommerce',     'Ecommerce',             '#8f1f1f', 'Website · Product pages · Tech',                        60, true,  'hiring'),
      (p_org_id, 'brand',         'Brand',                 '#444444', 'PR · Packaging · Labeling · Brand guidelines',          70, false, 'filled'),
      (p_org_id, 'creative',      'Creative',              '#5e3a8c', 'Design · Visual assets · Motion',                       80, false, 'filled'),
      (p_org_id, 'ai-productivity','AI & Productivity',    '#2a2a2a', 'Company-wide — all employees',                          90, false, 'filled');
    v_inserted_pillars := 9;
  end if;

  -- Policies (only if none exist for this org)
  if v_existing_policies = 0 then
    insert into public.gov_policies (org_id, code, body, enforced_by, sort_order, is_active) values
      (p_org_id, 'P01', 'All platform access is assigned to individual company email IDs (name@company.com). No personal email addresses permitted on any company platform.', 'IT', 10, true),
      (p_org_id, 'P02', 'Shared/generic emails (e.g. amazon@company.com) are reserved exclusively for platform ownership, account recovery, and continuity. They are never used for day-to-day login by individuals.', 'IT', 20, true),
      (p_org_id, 'P03', 'Shared credentials are strictly prohibited except where technically unavoidable. All exceptions must be documented and approved by IT and the Founder.', 'IT & Founder', 30, true),
      (p_org_id, 'P04', 'External parties (agencies, consultants, freelancers) must access platforms via managed links only — Google Ads MCC, Meta Business Manager partner link, or platform-native guest access. No direct credentials are issued to external parties.', 'IT', 40, true),
      (p_org_id, 'P05', 'All access provisioning, changes, and revocations are routed through IT/Admin. No individual self-provisions access to any company platform.', 'IT', 50, true),
      (p_org_id, 'P06', 'Employee exit: Individual access is revoked within 24 hours of departure. External MCC/BM links are removed within 24 hours of agency contract termination. Platform ownership emails remain unchanged — business retains full control.', 'IT', 60, true),
      (p_org_id, 'P07', 'Employee onboarding: IT provisions access based on role and pillar within 48 hours of start date. Access level follows the pillar access model.', 'IT', 70, true),
      (p_org_id, 'P08', 'The Individual Access Register is reviewed every 6 months or after any team restructuring. IT is responsible for keeping it current.', 'IT', 80, true);
    v_inserted_policies := 8;
  end if;

  -- Audit
  if v_inserted_pillars > 0 or v_inserted_policies > 0 then
    insert into public.gov_audit_events (org_id, actor_id, entity_type, entity_id, action, detail)
    values (
      p_org_id, auth.uid(), 'system', null, 'seed',
      jsonb_build_object('pillars_inserted', v_inserted_pillars, 'policies_inserted', v_inserted_policies)
    );
  end if;

  return jsonb_build_object(
    'pillars_inserted',  v_inserted_pillars,
    'policies_inserted', v_inserted_policies,
    'pillars_existing',  v_existing_pillars,
    'policies_existing', v_existing_policies
  );
end$$;

revoke all on function public.gov_seed_default_pillars(uuid) from public;
grant execute on function public.gov_seed_default_pillars(uuid) to authenticated;
grant execute on function public.gov_seed_default_pillars(uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Convenience view: pillars + their owner + member counts
-- Used by the Leadership Overview tab to render the summary table without
-- N+1 round-trips from the frontend.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.v_gov_pillars_summary as
  select
    p.id, p.org_id, p.code, p.name, p.color, p.functions_desc,
    p.reports_to_pillar_id, p.hiring_flag, p.status, p.sort_order,
    -- Owner = highest-precedence assignment with role='owner' or 'admin' (acting)
    (select e.full_name
       from public.gov_pillar_assignments a
       join public.employees e on e.id = a.employee_id
      where a.pillar_id = p.id and a.role = 'owner'
      order by a.is_acting asc, a.created_at asc
      limit 1)                                                                                    as owner_name,
    (select e.full_name
       from public.gov_pillar_assignments a
       join public.employees e on e.id = a.employee_id
      where a.pillar_id = p.id and a.role = 'admin'
      order by a.is_acting asc, a.created_at asc
      limit 1)                                                                                    as backup_name,
    (select count(*) from public.gov_pillar_assignments a where a.pillar_id = p.id)               as member_count,
    (select count(*) from public.gov_pillar_platforms     pl where pl.pillar_id = p.id)           as platform_count
  from public.gov_pillars p;

grant select on public.v_gov_pillars_summary to authenticated;

COMMIT;
