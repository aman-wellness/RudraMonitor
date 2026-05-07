-- TrackForce Supabase schema
-- Run this in Supabase SQL editor (Project → SQL → New query)

-- Extensions
create extension if not exists "pgcrypto";

-- =============== organizations ===============
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  gst_number text,
  address text,
  city text,
  state text,
  country text default 'India',
  phone text,
  created_at timestamptz not null default now(),
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  subscription_status text not null default 'trial',  -- trial | active | expired
  subscription_type text default 'monthly',           -- monthly | yearly
  license_count int not null default 5,
  license_key text not null default encode(gen_random_bytes(12), 'hex')
);

create index if not exists organizations_owner_idx on public.organizations(owner_user_id);

-- =============== org_members ===============
-- Multiple admins/users can belong to one organization
create table if not exists public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'admin',   -- owner | admin | viewer
  full_name text,
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create index if not exists org_members_user_idx on public.org_members(user_id);
create index if not exists org_members_org_idx on public.org_members(org_id);

-- =============== agents ===============
-- An "agent" = a single employee machine running the desktop monitor
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  agent_name text not null,
  os_type text,              -- Windows | macOS | Ubuntu
  status text default 'offline',  -- online | offline | idle
  last_active timestamptz,
  ip_address text,
  enroll_token text unique default encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now()
);

create index if not exists agents_org_idx on public.agents(org_id);

-- =============== activity_logs ===============
create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  activity_type text not null,    -- app | browser | idle | alert
  application_name text,
  url text,
  duration int,                   -- seconds
  screenshot_url text,
  video_url text,
  created_at timestamptz not null default now()
);

create index if not exists activity_logs_agent_time_idx on public.activity_logs(agent_id, created_at desc);

-- =============== system_metrics ===============
create table if not exists public.system_metrics (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  cpu_usage int,
  ram_usage int,
  disk_usage int,
  battery_level int,
  network_speed text,
  recorded_at timestamptz not null default now()
);

create index if not exists system_metrics_agent_time_idx on public.system_metrics(agent_id, recorded_at desc);

-- =============== alerts ===============
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  alert_type text not null,       -- error | warning | info
  message text not null,
  ai_resolved boolean default false,
  resolution text,
  created_at timestamptz not null default now()
);

create index if not exists alerts_agent_time_idx on public.alerts(agent_id, created_at desc);

-- =============== Row Level Security ===============
alter table public.organizations enable row level security;
alter table public.org_members   enable row level security;
alter table public.agents        enable row level security;
alter table public.activity_logs enable row level security;
alter table public.system_metrics enable row level security;
alter table public.alerts        enable row level security;

-- Helper: which orgs does the current user belong to?
create or replace function public.user_org_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.org_members where user_id = auth.uid()
$$;

-- organizations: members can read their org; owner can update; anyone authenticated can insert (for signup flow)
drop policy if exists org_select on public.organizations;
create policy org_select on public.organizations
  for select using (id in (select public.user_org_ids()));

drop policy if exists org_insert on public.organizations;
create policy org_insert on public.organizations
  for insert with check (auth.uid() = owner_user_id);

drop policy if exists org_update on public.organizations;
create policy org_update on public.organizations
  for update using (owner_user_id = auth.uid());

-- org_members: user can see members of their orgs; user can insert themselves
drop policy if exists members_select on public.org_members;
create policy members_select on public.org_members
  for select using (org_id in (select public.user_org_ids()) or user_id = auth.uid());

drop policy if exists members_insert on public.org_members;
create policy members_insert on public.org_members
  for insert with check (user_id = auth.uid());

-- agents: scoped to org
drop policy if exists agents_select on public.agents;
create policy agents_select on public.agents
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists agents_write on public.agents;
create policy agents_write on public.agents
  for all using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));

-- child tables: scoped via agent → org
drop policy if exists logs_select on public.activity_logs;
create policy logs_select on public.activity_logs
  for select using (agent_id in (select id from public.agents where org_id in (select public.user_org_ids())));

drop policy if exists metrics_select on public.system_metrics;
create policy metrics_select on public.system_metrics
  for select using (agent_id in (select id from public.agents where org_id in (select public.user_org_ids())));

drop policy if exists alerts_select on public.alerts;
create policy alerts_select on public.alerts
  for select using (agent_id in (select id from public.agents where org_id in (select public.user_org_ids())));

-- NOTE: writes to activity_logs / system_metrics / alerts come from the desktop agent,
-- which will authenticate via service role (Edge Function) — no RLS write policy needed for users.
