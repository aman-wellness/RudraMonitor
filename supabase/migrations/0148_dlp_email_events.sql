-- 0148_dlp_email_events.sql
--
-- Full Email DLP schema — Phase 1 of the HTTPS-interception plan.
--
-- Adds three new tables:
--
-- 1. dlp_email_events         one row per intercepted webmail send/reply/forward
-- 2. dlp_email_attachments    one row per attachment (multi-file per event)
-- 3. dlp_public_providers     canonical list of public webmail hosts the agent
--                              proxy actually terminates TLS on
--
-- The existing dlp_events (0019) is left untouched — it keeps handling
-- USB transfers and legacy "email hostname visit" events. Full email
-- content lives in the new tables so we can index / query without bloat
-- on the small-row dlp_events table.
--
-- RLS mirrors dlp_events: org_id in user_org_ids(). Agent inserts happen
-- via the dlp-email-ingest edge fn under service_role, so the RLS
-- policies target dashboard readers only.

-- ============================ 1. providers ============================

create table if not exists public.dlp_public_providers (
  host       text primary key,
  name       text not null,
  enabled    boolean not null default true,
  -- Server-driven so we can add a provider (or disable a broken one)
  -- without shipping a new agent — the agent polls agent-settings which
  -- returns the current list.
  updated_at timestamptz not null default now()
);

comment on table public.dlp_public_providers is
  'Canonical list of public webmail hosts (Gmail, Yahoo, etc.) the MITM proxy terminates TLS on. Corporate M365/Google-Workspace stay outside this list.';

insert into public.dlp_public_providers (host, name) values
  ('mail.google.com',        'Gmail'),
  ('gmail.com',              'Gmail'),
  ('mail.yahoo.com',         'Yahoo Mail'),
  ('yahoo.com',              'Yahoo Mail'),
  ('outlook.live.com',       'Outlook.com'),
  ('outlook.com',            'Outlook.com'),
  ('hotmail.com',            'Hotmail'),
  ('mail.aol.com',           'AOL Mail'),
  ('aol.com',                'AOL Mail'),
  ('mail.proton.me',         'ProtonMail'),
  ('protonmail.com',         'ProtonMail'),
  ('mail.icloud.com',        'iCloud Mail'),
  ('icloud.com',             'iCloud Mail'),
  ('mail.zoho.com',          'Zoho Mail (personal)'),
  ('zoho.com',               'Zoho Mail (personal)'),
  ('mail.rediff.com',        'Rediffmail'),
  ('rediffmail.com',         'Rediffmail'),
  ('gmx.com',                'GMX'),
  ('mail.com',               'Mail.com'),
  ('mail.yandex.com',        'Yandex Mail'),
  ('yandex.com',             'Yandex Mail')
on conflict (host) do nothing;

-- Providers are org-global metadata, not tenant data — anyone
-- authenticated can read the list (needed by the dashboard settings
-- panel + agent-settings endpoint). Writes stay service-role only.
alter table public.dlp_public_providers enable row level security;
drop policy if exists dlp_public_providers_read on public.dlp_public_providers;
create policy dlp_public_providers_read on public.dlp_public_providers
  for select to authenticated using (true);

-- ============================ 2. events ============================

create table if not exists public.dlp_email_events (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  agent_id          uuid not null references public.agents(id) on delete cascade,
  -- Provider metadata resolved by the agent at capture time.
  mail_provider     text not null,   -- e.g. 'Gmail', 'Yahoo Mail'
  mail_url          text,            -- the exact request URL the send fired on
  -- Header fields extracted from the intercepted request body.
  from_address      text,
  subject           text,
  body_text         text,
  body_html         text,            -- HTML preserved for the admin review UI
  to_recipients     text[] not null default '{}',
  cc_recipients     text[] not null default '{}',
  bcc_recipients    text[] not null default '{}',
  attachments_count integer not null default 0,
  -- Optional screenshot captured at send-time (screenshots bucket path).
  screenshot_url    text,
  active_window     text,
  -- AI classification (reuses the same pipeline as dlp_events).
  ai_authorized     boolean,
  ai_severity       text check (ai_severity in ('low','medium','high','critical')),
  ai_reason         text,
  ai_model          text,
  ai_processed_at   timestamptz,
  -- Alert bookkeeping (mirrors dlp_events).
  alert_sent_at     timestamptz,
  alert_email       text,
  -- Ingest lifecycle: rows land as 'pending' with signed upload URLs
  -- for each attachment, agent PUTs bytes, then calls finalize which
  -- flips this to 'ingested'. Rows stuck at 'pending' > 30 min are
  -- reaped by the same cron that handles tool_runs (0139_tool_runs_stale_reaper).
  ingest_state      text not null default 'pending'
                     check (ingest_state in ('pending','ingested','failed')),
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

create index if not exists dlp_email_events_org_created_idx
  on public.dlp_email_events (org_id, created_at desc);
create index if not exists dlp_email_events_agent_created_idx
  on public.dlp_email_events (agent_id, created_at desc);
create index if not exists dlp_email_events_provider_idx
  on public.dlp_email_events (mail_provider);
create index if not exists dlp_email_events_severity_idx
  on public.dlp_email_events (org_id, ai_severity, occurred_at desc)
  where ai_severity is not null;

alter table public.dlp_email_events enable row level security;

-- Dashboard: any org member can read their org's rows.
drop policy if exists dlp_email_events_read on public.dlp_email_events;
create policy dlp_email_events_read on public.dlp_email_events
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

-- No insert/update from authenticated — the ingest edge fn writes as
-- service_role. Explicitly deny to be safe.
revoke insert, update, delete on public.dlp_email_events from anon, authenticated;

comment on table public.dlp_email_events is
  'Intercepted webmail sends: subject, body, recipients, attachment count. Full attachment bytes live in dlp_email_attachments + Storage.';

-- ============================ 3. attachments ============================

create table if not exists public.dlp_email_attachments (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.dlp_email_events(id) on delete cascade,
  org_id            uuid not null references public.organizations(id) on delete cascade,
  file_name         text not null,
  file_size_bytes   bigint not null,
  file_mime         text,
  file_hash_sha256  text,
  -- Path inside the private dlp-email-attachments Storage bucket
  -- (bucket + policies created in a follow-up because Storage buckets
  -- are managed via API/dashboard, not raw SQL, on this deploy).
  -- Path shape: <org_id>/<agent_id>/<event_id>/<hash>-<file_name>
  storage_path      text not null,
  -- Set once the agent's PUT to the signed upload URL completes.
  uploaded_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists dlp_email_attachments_event_idx
  on public.dlp_email_attachments (event_id);
create index if not exists dlp_email_attachments_org_created_idx
  on public.dlp_email_attachments (org_id, created_at desc);

alter table public.dlp_email_attachments enable row level security;

drop policy if exists dlp_email_attachments_read on public.dlp_email_attachments;
create policy dlp_email_attachments_read on public.dlp_email_attachments
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

revoke insert, update, delete on public.dlp_email_attachments from anon, authenticated;

comment on table public.dlp_email_attachments is
  'One row per attachment on a dlp_email_events row. storage_path points at the private dlp-email-attachments bucket.';

-- ============================ 4. settings extension ============================

-- Two new fields on the existing per-org dlp_settings row (0019_dlp.sql):
-- - email_intercept_public_only: master switch for the MITM proxy, on by
--   default because the whole point of this module is to see personal-email
--   exfil. An org can turn it off if they haven't rolled out the CA yet.
-- - email_body_capture: some jurisdictions restrict full-body capture — a
--   toggle to store only subject + recipients + attachment metadata
--   without body_text / body_html.
alter table public.dlp_settings
  add column if not exists email_intercept_public_only boolean not null default true,
  add column if not exists email_body_capture         boolean not null default true;

-- ============================ 5. stale-row reaper (reuses cron) ============================

-- Attach onto the pg_cron sweeper that already runs every 5 min
-- (0139_tool_runs_stale_reaper). Pending rows stuck for > 30 min are
-- flipped to failed so the dashboard doesn't accumulate ghosts.
create or replace function public.reap_stale_dlp_email_events()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.dlp_email_events
    set ingest_state = 'failed'
    where ingest_state = 'pending'
      and created_at < now() - interval '30 minutes';
end $$;

revoke execute on function public.reap_stale_dlp_email_events() from public, anon, authenticated;

-- Register with pg_cron under the same schedule that already runs for
-- tool_runs. If cron.job doesn't exist here (single-node dev) this is a
-- no-op.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('dlp_email_reap_stale');
    perform cron.schedule(
      'dlp_email_reap_stale',
      '*/5 * * * *',
      $sql$select public.reap_stale_dlp_email_events();$sql$
    );
  end if;
exception when others then
  -- pg_cron not present in this environment — skip silently.
  null;
end $$;

notify pgrst, 'reload schema';
