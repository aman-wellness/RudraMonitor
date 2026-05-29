-- 0085_invoice_fetch_cron.sql
-- Daily tick that enqueues invoice-fetch jobs for credentials whose current
-- billing period has started and which don't yet have an invoice for that
-- period. The actual delivery is asynchronous — `invoice-sync` (API) and
-- `invoice-inbound` (email) consume the queue, the EC2 browser worker
-- handles the rest.
--
-- Reuse the pg_cron + pg_net + Vault pattern from migration 0033.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- ── Period helper ─────────────────────────────────────────────────────────
-- Given a credential's subscription_starts_at + billing_cycle, returns the
-- current period bounds. Defaults to monthly anchored on the start day.
create or replace function public.invoice_period_for(
  p_starts_at  timestamptz,
  p_cycle      text,
  p_now        timestamptz default now()
) returns table(period_start date, period_end date)
language plpgsql immutable as $$
declare
  v_start date;
  v_cycle text := coalesce(lower(p_cycle), 'monthly');
  v_anchor date := coalesce(p_starts_at::date, p_now::date);
  v_day int := extract(day from v_anchor)::int;
begin
  if v_cycle = 'yearly' or v_cycle = 'annual' then
    v_start := make_date(extract(year from p_now)::int, extract(month from v_anchor)::int, least(v_day, 28));
    if v_start > p_now::date then v_start := v_start - interval '1 year'; end if;
    return query select v_start, (v_start + interval '1 year' - interval '1 day')::date;
  elsif v_cycle = 'quarterly' then
    v_start := make_date(extract(year from p_now)::int, extract(month from p_now)::int, least(v_day, 28));
    if v_start > p_now::date then v_start := v_start - interval '1 month'; end if;
    return query select v_start, (v_start + interval '3 months' - interval '1 day')::date;
  else
    -- monthly default
    v_start := make_date(extract(year from p_now)::int, extract(month from p_now)::int, least(v_day, 28));
    if v_start > p_now::date then v_start := v_start - interval '1 month'; end if;
    return query select v_start, (v_start + interval '1 month' - interval '1 day')::date;
  end if;
end$$;

-- ── Enqueue function ──────────────────────────────────────────────────────
-- Returns count of jobs inserted. Idempotent — the unique partial index on
-- (credential_id, billing_period_start) for open statuses blocks duplicates.
create or replace function public.invoice_fetch_enqueue()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int := 0;
  c record;
  p record;
begin
  for c in
    select id, org_id, billing_cycle, subscription_starts_at, billing_api_provider
      from public.credentials
     where active = true
       and coalesce(auto_fetch_enabled, true) = true
       and (subscription_ends_at is null or subscription_ends_at >= now())
       and subscription_starts_at is not null
  loop
    -- Compute current period.
    select * into p from public.invoice_period_for(c.subscription_starts_at, c.billing_cycle);

    -- Only enqueue if at least 24 h have passed since period start (give
    -- platforms time to issue the invoice).
    if p.period_start > (now()::date - 1) then
      continue;
    end if;

    -- Skip if we already have an invoice covering this period.
    if exists (
      select 1 from public.credential_invoices
       where credential_id = c.id
         and ( (period_start is not null and period_start = p.period_start)
            or (issue_date is not null and issue_date between p.period_start and p.period_end))
    ) then
      continue;
    end if;

    -- Insert job (no-op on conflict thanks to the partial unique index).
    begin
      insert into public.invoice_fetch_jobs (
        org_id, credential_id, billing_period_start, billing_period_end,
        tier, status
      ) values (
        c.org_id, c.id, p.period_start, p.period_end,
        case when c.billing_api_provider is not null then 'api' else 'email' end,
        'queued'
      );
      v_inserted := v_inserted + 1;
    exception when unique_violation then
      null;  -- already an open job
    end;
  end loop;
  return v_inserted;
end$$;

revoke all on function public.invoice_fetch_enqueue() from public, anon, authenticated;

-- ── Tick (fires the edge worker after enqueueing) ─────────────────────────
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
begin
  v_count := public.invoice_fetch_enqueue();

  select decrypted_secret into v_jwt
    from vault.decrypted_secrets
   where name = 'directory_sync_service_role_jwt'   -- reuse the existing vault secret
   limit 1;
  if v_jwt is null then return; end if;

  v_url := 'http://kong:8000/functions/v1/invoice-fetch-dispatch';

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_jwt,
      'Content-Type', 'application/json'
    )::jsonb,
    body := jsonb_build_object('scheduled', true, 'enqueued', v_count)
  );
end$$;

revoke all on function public.invoice_fetch_tick() from public, anon, authenticated;

-- Unschedule old version (idempotent re-runs).
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'invoice_fetch_tick'
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$$;

-- Daily at 06:30 UTC ≈ 12:00 IST — most platforms have invoiced the previous
-- day's billing run by then.
select cron.schedule(
  'invoice_fetch_tick',
  '30 6 * * *',
  $$ select public.invoice_fetch_tick(); $$
);
