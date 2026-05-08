-- 0019_dlp.sql
-- Data Loss Prevention (DLP) — track USB transfers + email-attached file uploads,
-- AI-classify each event, alert super-admin via Microsoft Graph email.
--
-- Add-on billing: $3 / ₹250 per agent per month, tracked as a flag on agents
-- and aggregated into the customer's monthly invoice.

------------------------------------------------------------
-- 1. Plans: optional DLP add-on price
------------------------------------------------------------
alter table public.plans
  add column if not exists dlp_addon_price_inr numeric(10,2) default 250.00;

comment on column public.plans.dlp_addon_price_inr is
  'Per-agent monthly price for DLP add-on. NULL = DLP not available on this plan.';

------------------------------------------------------------
-- 2. Per-agent DLP enabled flag
------------------------------------------------------------
alter table public.agents
  add column if not exists dlp_enabled boolean not null default false;

create index if not exists agents_dlp_enabled_idx
  on public.agents(org_id) where dlp_enabled = true;

------------------------------------------------------------
-- 3. dlp_events — every USB transfer / email upload the agent observes
------------------------------------------------------------
create table if not exists public.dlp_events (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  agent_id        uuid not null references public.agents(id) on delete cascade,

  -- Event classification
  event_type      text not null check (event_type in ('usb_transfer','email_attachment','clipboard_exfil')),
  direction       text check (direction in ('to_external','from_external','unknown')),

  -- USB-specific
  device_name     text,
  device_serial   text,
  device_type     text,        -- 'mass_storage' | 'mtp' | 'phone' | ...

  -- Email-specific
  mail_provider   text,        -- 'gmail' | 'yahoo' | 'outlook' | 'rediffmail' | ...
  mail_url        text,        -- e.g. https://mail.google.com/mail/u/0/#inbox?compose=...
  recipient_email text,

  -- Common
  file_path       text,
  file_name       text,
  file_size_bytes bigint,
  file_mime       text,
  file_hash_sha256 text,       -- so we can dedupe identical files across events

  -- Surrounding context captured by agent
  active_window   text,
  screenshot_url  text,        -- storage path (same bucket as regular screenshots)

  -- AI classification (filled in by dlp-classify edge fn)
  ai_authorized   boolean,
  ai_severity     text check (ai_severity in ('low','medium','high','critical')),
  ai_reason       text,
  ai_model        text,        -- 'claude-opus-4-7' | 'gpt-4o' (fallback)
  ai_processed_at timestamptz,

  -- Alert delivery
  alert_sent_at   timestamptz,
  alert_email     text,        -- which super-admin mailbox received it

  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists dlp_events_org_idx       on public.dlp_events(org_id, occurred_at desc);
create index if not exists dlp_events_agent_idx     on public.dlp_events(agent_id, occurred_at desc);
create index if not exists dlp_events_type_idx      on public.dlp_events(org_id, event_type, occurred_at desc);
create index if not exists dlp_events_severity_idx  on public.dlp_events(org_id, ai_severity, occurred_at desc)
  where ai_severity in ('high','critical');
create index if not exists dlp_events_unsent_idx    on public.dlp_events(occurred_at)
  where ai_authorized = false and alert_sent_at is null;

------------------------------------------------------------
-- 4. dlp_alert_recipients — super-admin email addresses to notify per org.
--    Most customers will want one shared mailbox; some may add a security@ alias.
------------------------------------------------------------
create table if not exists public.dlp_alert_recipients (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  email       text not null,
  full_name   text,
  is_active   boolean not null default true,
  -- Severities this recipient should receive (subset of low/medium/high/critical)
  severities  text[] not null default array['high','critical'],
  created_at  timestamptz not null default now(),
  unique (org_id, email)
);

-- Global recipients (org_id IS NULL) catch DLP alerts from EVERY org — used for
-- TrackForce's own ops team / CSM bcc.
create index if not exists dlp_recipients_org_idx
  on public.dlp_alert_recipients(org_id) where is_active = true;
create index if not exists dlp_recipients_global_idx
  on public.dlp_alert_recipients(email) where org_id is null and is_active = true;

------------------------------------------------------------
-- 5. dlp_settings — single-row config per org (policies + AI prompt)
------------------------------------------------------------
create table if not exists public.dlp_settings (
  org_id              uuid primary key references public.organizations(id) on delete cascade,
  -- Per-event-type enable. Org admin can switch off email tracking even when DLP is on.
  usb_enabled         boolean not null default true,
  email_enabled       boolean not null default true,
  clipboard_enabled   boolean not null default false,
  -- Whitelist of mail domains that are OK (e.g. customer's company domain)
  authorized_domains  text[] not null default array[]::text[],
  -- Comma-list patterns that ALWAYS flag (regardless of AI)
  blocked_keywords    text[] not null default array[]::text[],
  -- Custom guidance prepended to AI classification prompt
  ai_policy_prompt    text,
  updated_at          timestamptz not null default now()
);

------------------------------------------------------------
-- 6. RLS
------------------------------------------------------------
alter table public.dlp_events            enable row level security;
alter table public.dlp_alert_recipients  enable row level security;
alter table public.dlp_settings          enable row level security;

-- dlp_events: org members read; super-admin all
drop policy if exists dlp_events_org_read on public.dlp_events;
create policy dlp_events_org_read on public.dlp_events for select
  using (exists (
    select 1 from public.org_members m
    where m.org_id = dlp_events.org_id and m.user_id = auth.uid()
  ));

drop policy if exists dlp_events_super_all on public.dlp_events;
create policy dlp_events_super_all on public.dlp_events for all
  using (public.is_super_admin()) with check (public.is_super_admin());

-- dlp_alert_recipients: org admin read/write; super-admin all
drop policy if exists dlp_recipients_org_admin on public.dlp_alert_recipients;
create policy dlp_recipients_org_admin on public.dlp_alert_recipients for all
  using (
    org_id is not null and exists (
      select 1 from public.org_members m
      where m.org_id = dlp_alert_recipients.org_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  ) with check (
    org_id is not null and exists (
      select 1 from public.org_members m
      where m.org_id = dlp_alert_recipients.org_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  );

drop policy if exists dlp_recipients_super_all on public.dlp_alert_recipients;
create policy dlp_recipients_super_all on public.dlp_alert_recipients for all
  using (public.is_super_admin()) with check (public.is_super_admin());

-- dlp_settings: same as recipients
drop policy if exists dlp_settings_org_admin on public.dlp_settings;
create policy dlp_settings_org_admin on public.dlp_settings for all
  using (exists (
    select 1 from public.org_members m
    where m.org_id = dlp_settings.org_id
      and m.user_id = auth.uid()
      and m.role in ('owner','admin')
  )) with check (exists (
    select 1 from public.org_members m
    where m.org_id = dlp_settings.org_id
      and m.user_id = auth.uid()
      and m.role in ('owner','admin')
  ));

drop policy if exists dlp_settings_super_all on public.dlp_settings;
create policy dlp_settings_super_all on public.dlp_settings for all
  using (public.is_super_admin()) with check (public.is_super_admin());

------------------------------------------------------------
-- 7. Auto-seed dlp_settings for new orgs
------------------------------------------------------------
create or replace function public.handle_new_org_dlp_defaults()
returns trigger language plpgsql security definer as $$
begin
  insert into public.dlp_settings (org_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists trg_org_dlp_defaults on public.organizations;
create trigger trg_org_dlp_defaults
  after insert on public.organizations
  for each row execute function public.handle_new_org_dlp_defaults();

-- Backfill existing orgs
insert into public.dlp_settings (org_id)
select id from public.organizations
on conflict do nothing;
