-- 0041_hardware_inventory.sql
-- IT hardware inventory — laptops, desktops, monitors etc. Tracked per-org
-- with full assignment lifecycle (who currently has it + a historical
-- assignment log). Offboarding stage 2 auto-unassigns the user's devices
-- so IT doesn't have to chase the row down manually.

create table if not exists public.hardware_assets (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,

  device_serial        text not null,
  device_tag           text,                          -- internal sticker / asset tag
  device_type          text default 'laptop'          -- laptop | desktop | monitor | phone | other
                       check (device_type in ('laptop','desktop','monitor','phone','tablet','accessory','other')),
  configuration        text,                          -- free-text, e.g. "MacBook Pro 14, M3 Pro, 18GB/512GB"
  ram_gb               int,
  disk_gb              int,
  brand                text,
  model                text,

  purchase_price       numeric(12, 2),
  purchase_currency    text,
  purchase_date        date,

  assigned_employee_id uuid references public.employees(id) on delete set null,
  assigned_at          timestamptz,
  unassigned_at        timestamptz,

  status               text not null default 'in_stock'
                       check (status in ('in_stock','assigned','retired','lost','rma')),
  notes                text,

  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (org_id, device_serial)
);

create index if not exists hardware_assets_org_idx      on public.hardware_assets(org_id);
create index if not exists hardware_assets_assignee_idx on public.hardware_assets(assigned_employee_id);
create index if not exists hardware_assets_status_idx   on public.hardware_assets(org_id, status);

create or replace function public.touch_hardware_assets_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_hardware_assets_touch on public.hardware_assets;
create trigger trg_hardware_assets_touch before update on public.hardware_assets
  for each row execute function public.touch_hardware_assets_updated_at();

-- ============== Assignment history (append-only audit) ==============
create table if not exists public.hardware_assignments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  asset_id        uuid not null references public.hardware_assets(id) on delete cascade,
  employee_id     uuid references public.employees(id) on delete set null,
  assigned_by     uuid references auth.users(id) on delete set null,
  assigned_at     timestamptz not null default now(),
  unassigned_at   timestamptz,
  unassign_reason text,                                -- 'offboarding' | 'reassigned' | 'returned' | free text
  unassigned_by   uuid references auth.users(id) on delete set null
);

create index if not exists hardware_assignments_asset_idx on public.hardware_assignments(asset_id, assigned_at desc);
create index if not exists hardware_assignments_emp_idx   on public.hardware_assignments(employee_id, assigned_at desc);

-- ============== RLS ==============
alter table public.hardware_assets      enable row level security;
alter table public.hardware_assignments enable row level security;

drop policy if exists hardware_assets_select on public.hardware_assets;
create policy hardware_assets_select on public.hardware_assets
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists hardware_assets_write on public.hardware_assets;
create policy hardware_assets_write on public.hardware_assets
  for all using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));

drop policy if exists hardware_assignments_select on public.hardware_assignments;
create policy hardware_assignments_select on public.hardware_assignments
  for select using (org_id in (select public.user_org_ids()));
