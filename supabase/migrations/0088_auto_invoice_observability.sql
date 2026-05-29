-- 0088_auto_invoice_observability.sql
-- Phase-4: tracking + observability for the auto-invoice pipeline.
--
--   • invoice_fetch_events   — append-only audit row per state-change
--                              ('job_started', 'tier_api_pulled',
--                              'needs_otp', 'otp_received', 'pdf_saved',
--                              'forwarded', 'failed', 'cron_tick',
--                              'channel_ping_*'). Drives the Today
--                              activity feed in the command center.
--
--   • cron_runs              — one row per pg_cron tick of
--                              invoice_fetch_tick(). Lets the customer
--                              see "cron actually ran at 06:30, enqueued
--                              4 jobs, no errors" — and notice if it
--                              silently stops.
--
--   • v_credential_coverage  — credentials × last 6 months grid showing
--                              whether each (credential, month) has at
--                              least one invoice. Drives the matrix.

create table if not exists public.invoice_fetch_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  credential_id uuid references public.credentials(id) on delete cascade,
  job_id        uuid references public.invoice_fetch_jobs(id) on delete cascade,
  invoice_id    uuid references public.credential_invoices(id) on delete set null,

  kind          text not null,           -- see constraint below
  actor         text,                    -- 'cron' | 'dispatcher' | 'worker' | 'webhook' | 'admin:<user_id>'
  channel       text,                    -- where applicable: 'slack' | 'teams' | …
  message       text,                    -- short human-readable line for the feed
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),

  constraint invoice_fetch_events_kind_chk check (kind in (
    'job_queued','job_started','job_completed','job_failed',
    'tier_api_pulled','tier_email_received','tier_scrape_started',
    'needs_otp','otp_received','otp_expired',
    'pdf_saved','forwarded','forward_skipped','forward_failed',
    'cron_tick','channel_ping_sent','channel_ping_failed',
    'silent_failure_alert'
  ))
);

create index if not exists invoice_fetch_events_org_idx on public.invoice_fetch_events(org_id, created_at desc);
create index if not exists invoice_fetch_events_job_idx on public.invoice_fetch_events(job_id, created_at);
create index if not exists invoice_fetch_events_cred_idx on public.invoice_fetch_events(credential_id, created_at desc);

alter table public.invoice_fetch_events enable row level security;

drop policy if exists invoice_fetch_events_select on public.invoice_fetch_events;
create policy invoice_fetch_events_select on public.invoice_fetch_events
  for select using (org_id in (select public.user_org_ids()));

-- Realtime so the activity feed updates without polling.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'invoice_fetch_events'
  ) then
    alter publication supabase_realtime add table public.invoice_fetch_events;
  end if;
end$$;

-- ── cron_runs ──────────────────────────────────────────────────────────────
create table if not exists public.cron_runs (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,                       -- 'invoice_fetch_tick' | 'auto_invoice_digest' | …
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  ok           boolean,
  enqueued     int default 0,
  error        text
);

create index if not exists cron_runs_name_idx on public.cron_runs(name, started_at desc);

alter table public.cron_runs enable row level security;

-- Read-only for any logged-in user (cron-runs is non-sensitive ops data).
drop policy if exists cron_runs_select on public.cron_runs;
create policy cron_runs_select on public.cron_runs
  for select using (auth.role() = 'authenticated');

-- ── Patch invoice_fetch_tick to record its own runs ────────────────────────
create or replace function public.invoice_fetch_tick()
returns void
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_jwt text;
  v_url text;
  v_count int;
  v_run_id uuid;
begin
  insert into public.cron_runs(name) values ('invoice_fetch_tick') returning id into v_run_id;

  begin
    v_count := public.invoice_fetch_enqueue();

    select decrypted_secret into v_jwt
      from vault.decrypted_secrets
     where name = 'directory_sync_service_role_jwt'
     limit 1;

    if v_jwt is not null then
      v_url := 'http://kong:8000/functions/v1/invoice-fetch-dispatch';
      perform net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || v_jwt,
          'Content-Type', 'application/json'
        )::jsonb,
        body := jsonb_build_object('scheduled', true, 'enqueued', v_count)
      );
    end if;

    update public.cron_runs
       set completed_at = now(), ok = true, enqueued = v_count
     where id = v_run_id;

    -- Drop a feed event for each org that got jobs (best-effort summary).
    insert into public.invoice_fetch_events (org_id, kind, actor, message, detail)
    select org_id, 'cron_tick', 'cron',
           'Daily cron: ' || count(*)::text || ' job(s) queued',
           jsonb_build_object('queued', count(*))
      from public.invoice_fetch_jobs
     where status = 'queued'
       and created_at > now() - interval '5 minutes'
     group by org_id;
  exception when others then
    update public.cron_runs
       set completed_at = now(), ok = false, error = sqlerrm
     where id = v_run_id;
    raise;
  end;
end$$;

revoke all on function public.invoice_fetch_tick() from public, anon, authenticated;

-- ── Coverage matrix view ──────────────────────────────────────────────────
-- One row per (credential, month) for the last 6 months. `state` is one of
--   'covered'  — at least one invoice in that month
--   'pending'  — current month's billing date hasn't passed yet
--   'missing'  — billing day passed, no invoice
--   'na'       — credential's subscription hadn't started by that month
create or replace view public.v_credential_coverage as
with months as (
  select date_trunc('month', now()) - (n || ' months')::interval as month_start
    from generate_series(0, 5) as n
),
combos as (
  select c.id as credential_id,
         c.org_id,
         c.platform_name,
         c.subscription_starts_at,
         c.subscription_ends_at,
         c.billing_cycle,
         c.auto_fetch_enabled,
         m.month_start::date as month_start,
         (m.month_start + interval '1 month' - interval '1 day')::date as month_end
    from public.credentials c
   cross join months m
   where c.active
)
select
  k.credential_id,
  k.org_id,
  k.platform_name,
  k.month_start,
  k.month_end,
  case
    when k.subscription_starts_at is null then 'na'
    when k.month_end < k.subscription_starts_at::date then 'na'
    when k.subscription_ends_at is not null
         and k.month_start > k.subscription_ends_at::date then 'na'
    when exists (
      select 1 from public.credential_invoices i
       where i.credential_id = k.credential_id
         and (
           (i.period_start is not null and i.period_start = k.month_start)
           or (i.issue_date between k.month_start and k.month_end)
         )
    ) then 'covered'
    when k.month_end > current_date then 'pending'
    else 'missing'
  end as state,
  (
    select count(*) from public.credential_invoices i
     where i.credential_id = k.credential_id
       and (
         (i.period_start is not null and i.period_start = k.month_start)
         or (i.issue_date between k.month_start and k.month_end)
       )
  ) as invoice_count
from combos k;

alter view public.v_credential_coverage set (security_invoker = true);
grant select on public.v_credential_coverage to authenticated;

-- ── Digest cron ───────────────────────────────────────────────────────────
-- Daily at 07:00 UTC. Edge fn handles silent-failure detection always +
-- weekly digest on Mondays.
create or replace function public.auto_invoice_digest_tick()
returns void
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_jwt text;
  v_run_id uuid;
begin
  insert into public.cron_runs(name) values ('auto_invoice_digest_tick') returning id into v_run_id;

  begin
    select decrypted_secret into v_jwt
      from vault.decrypted_secrets
     where name = 'directory_sync_service_role_jwt'
     limit 1;
    if v_jwt is null then
      update public.cron_runs set completed_at = now(), ok = false, error = 'no vault secret' where id = v_run_id;
      return;
    end if;
    perform net.http_post(
      url := 'http://kong:8000/functions/v1/auto-invoice-digest',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_jwt,
        'Content-Type', 'application/json'
      )::jsonb,
      body := jsonb_build_object('scheduled', true)
    );
    update public.cron_runs set completed_at = now(), ok = true where id = v_run_id;
  exception when others then
    update public.cron_runs set completed_at = now(), ok = false, error = sqlerrm where id = v_run_id;
    raise;
  end;
end$$;

revoke all on function public.auto_invoice_digest_tick() from public, anon, authenticated;

do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'auto_invoice_digest_tick'
  loop perform cron.unschedule(j.jobid); end loop;
end$$;

select cron.schedule(
  'auto_invoice_digest_tick',
  '0 7 * * *',
  $$ select public.auto_invoice_digest_tick(); $$
);
