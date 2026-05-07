-- Per-org classification rules. Each rule says "app X" or "host Y" is productive/unproductive/neutral.
-- The dashboard reads these to label entries in ApplicationsTab / BrowserTab and to compute the
-- Avg Productivity stat.

create table if not exists public.productivity_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  match_type text not null check (match_type in ('app','host')),
  pattern text not null,
  category text not null check (category in ('productive','unproductive','neutral')),
  created_at timestamptz not null default now(),
  unique (org_id, match_type, pattern)
);

create index if not exists productivity_rules_org_idx on public.productivity_rules (org_id);

alter table public.productivity_rules enable row level security;

drop policy if exists rules_select on public.productivity_rules;
create policy rules_select on public.productivity_rules
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists rules_write on public.productivity_rules;
create policy rules_write on public.productivity_rules
  for all
  using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));
