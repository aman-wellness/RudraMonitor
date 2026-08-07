-- 0119_email_signatures.sql
-- Centralized Outlook email signature management.
--
-- Admin defines ONE HTML signature template per organisation with token
-- placeholders ({{firstName}}, {{title}}, {{mobilePhone}}, …); the edge
-- function `signatures-push` renders it per-user against directory_users +
-- employees and calls the Exchange Online PowerShell REST API
-- (`Set-MailboxMessageConfiguration`) to install it as the user's real
-- Outlook signature. Works for New Outlook + Outlook Web out of the box;
-- classic desktop Outlook picks it up once the tenant has cloud/roaming
-- signatures enabled (Microsoft rollout, no code needed on our side).
--
-- Two tables:
--   signature_templates    — the org's active template (HTML + settings)
--   signature_push_status  — per-user apply history (last state + error)
--
-- Both org-scoped, RLS via is_org_member / is_org_writer (migration 0055).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- ENUM
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_type where typname = 'signature_push_state') then
    create type public.signature_push_state as enum ('pending','applied','failed','skipped');
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- signature_templates
-- One "active" template per org (partial unique index). We keep older versions
-- (is_active = false) so an admin can revert.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.signature_templates (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  name         text not null default 'Company signature',
  html_body    text not null,
  -- Auto-apply toggles that map 1:1 to Set-MailboxMessageConfiguration flags.
  -- Defaults match what customers overwhelmingly want (signature on new mail
  -- AND on reply/forward) — matches Outlook's "Automatically include my
  -- signature on messages I compose" + "on messages I reply to or forward".
  auto_add_new_message      boolean not null default true,
  auto_add_reply_forward    boolean not null default true,
  auto_add_mobile           boolean not null default true,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

-- Only ONE active template per org. Prevents ambiguity — the edge function
-- always pushes the row where is_active=true.
create unique index if not exists signature_templates_one_active_per_org
  on public.signature_templates(org_id)
  where is_active;

create index if not exists signature_templates_org_idx
  on public.signature_templates(org_id, created_at desc);

alter table public.signature_templates enable row level security;

drop policy if exists signature_templates_select on public.signature_templates;
create policy signature_templates_select on public.signature_templates
  for select using (public.is_org_member(org_id));

drop policy if exists signature_templates_insert on public.signature_templates;
create policy signature_templates_insert on public.signature_templates
  for insert with check (public.is_org_writer(org_id));

drop policy if exists signature_templates_update on public.signature_templates;
create policy signature_templates_update on public.signature_templates
  for update using (public.is_org_writer(org_id))
                with check (public.is_org_writer(org_id));

drop policy if exists signature_templates_delete on public.signature_templates;
create policy signature_templates_delete on public.signature_templates
  for delete using (public.is_org_writer(org_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- signature_push_status
-- One row per (template, employee). Insert-or-update on every push so the UI
-- can render a live table of "who has the current signature, who's failing".
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.signature_push_status (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references public.signature_templates(id) on delete cascade,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- employee_id preferred, but we also keep the raw UPN because some pushes
  -- target M365 users that aren't yet linked to an `employees` row (they
  -- exist in `directory_users` before HR onboards them).
  employee_id   uuid references public.employees(id) on delete cascade,
  upn           text not null,
  state         public.signature_push_state not null default 'pending',
  applied_at    timestamptz,
  last_error    text,
  attempts      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists signature_push_status_template_upn_idx
  on public.signature_push_status(template_id, upn);

create index if not exists signature_push_status_org_idx
  on public.signature_push_status(org_id, updated_at desc);

alter table public.signature_push_status enable row level security;

drop policy if exists signature_push_status_select on public.signature_push_status;
create policy signature_push_status_select on public.signature_push_status
  for select using (public.is_org_member(org_id));

-- Writes only from edge functions (service-role bypasses RLS). No policies
-- for insert/update/delete → any non-service-role attempt is rejected.

-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger: updated_at
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.set_updated_at_signatures()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_signature_templates_updated_at on public.signature_templates;
create trigger trg_signature_templates_updated_at
  before update on public.signature_templates
  for each row execute function public.set_updated_at_signatures();

drop trigger if exists trg_signature_push_status_updated_at on public.signature_push_status;
create trigger trg_signature_push_status_updated_at
  before update on public.signature_push_status
  for each row execute function public.set_updated_at_signatures();

COMMIT;
