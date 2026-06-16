-- 0114_usb_block_wallpaper_autoupdate.sql
--
-- Three related features that ship together in agent v0.3.0:
--   1. Removable disk block (per-agent toggle, default ON)
--   2. Central wallpaper push (org-wide image + per-agent exempt toggle)
--   3. Agent auto-updater foundation (signed builds bucket; manifest served via nginx)
--
-- All additive. No existing columns/rows touched. Safe to apply to a live prod.

-- ============== Per-agent flags ==============
alter table public.agents
  add column if not exists removable_disks_blocked boolean not null default true,
  add column if not exists wallpaper_enforced      boolean not null default true;

-- ============== Org-level wallpaper settings ==============
-- Single row per org; created lazily on first wallpaper upload.
create table if not exists public.organization_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  wallpaper_url        text,
  wallpaper_updated_at timestamptz,
  updated_at           timestamptz not null default now()
);

alter table public.organization_settings enable row level security;

drop policy if exists org_settings_read on public.organization_settings;
create policy org_settings_read on public.organization_settings
  for select using (
    org_id in (select org_id from public.org_members where user_id = auth.uid())
  );

drop policy if exists org_settings_write on public.organization_settings;
create policy org_settings_write on public.organization_settings
  for all using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

-- Auto-update updated_at on every change.
create or replace function public.organization_settings_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_org_settings_touch on public.organization_settings;
create trigger trg_org_settings_touch
  before update on public.organization_settings
  for each row execute function public.organization_settings_touch_updated_at();

-- ============== Storage buckets ==============
-- Wallpapers: org admin uploads → agents download. Public-read, ≤5 MB, JPEG/PNG.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wallpapers', 'wallpapers', true, 5242880,
        array['image/jpeg', 'image/png']::text[])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Agent build artifacts for Tauri updater. Public-read, 100 MB cap (signed .tar.gz/.zip).
-- Manifest layout: <bucket>/darwin-aarch64/latest.json, darwin-x86_64/latest.json,
-- windows-x86_64/latest.json. Each platform folder also holds the versioned bundle.
insert into storage.buckets (id, name, public, file_size_limit)
values ('agent-builds', 'agent-builds', true, 104857600)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- Storage RLS: writes restricted to org writers, reads public (already by bucket flag).
-- Wallpapers: bucket is public for reads; we constrain inserts via path prefix.
-- Path convention: <org_id>/<filename>.jpg
drop policy if exists wallpapers_write on storage.objects;
create policy wallpapers_write on storage.objects
  for all to authenticated
  using (
    bucket_id = 'wallpapers'
    and (storage.foldername(name))[1]::uuid in (
      select org_id from public.org_members where user_id = auth.uid()
    )
    and public.is_org_writer(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'wallpapers'
    and (storage.foldername(name))[1]::uuid in (
      select org_id from public.org_members where user_id = auth.uid()
    )
    and public.is_org_writer(((storage.foldername(name))[1])::uuid)
  );

-- agent-builds: writes happen from CI via service-role key, which bypasses RLS.
-- No customer-facing write policy needed.
