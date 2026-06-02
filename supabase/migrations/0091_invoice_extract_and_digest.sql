-- 0091_invoice_extract_and_digest.sql
-- Two related changes:
--
--   1. Drop the credential_id NOT NULL on credential_invoices so users
--      can drag-drop a random PDF without first picking which platform
--      it belongs to. The new "Add invoice" flow will let Claude vision
--      extract everything from the PDF; vendor → credential matching
--      runs server-side. Falls back to credential_id=NULL when no match
--      (UI surfaces these as "Unassigned").
--
--   2. Per-org configurable daily digest of newly-received invoices.
--      The existing accounts_recipient_emails fires PER INVOICE on
--      insert (good for visibility). The digest is a separate channel:
--      admin sets a custom local time + recipients, and at that time
--      a single email goes out listing every invoice received in the
--      last 24 hours. Useful for accounts teams that prefer one batch
--      a day over per-invoice noise.
--
-- Cron strategy: a single ticker runs every 15 minutes, checks each
-- org's digest_time + digest_timezone vs `now()` in that zone, and
-- fires the edge fn if (a) digest is enabled, (b) we're within 15 min
-- of the configured local time, (c) we haven't already sent today.

-- ── credential_invoices.credential_id → nullable ─────────────────────────
alter table public.credential_invoices
  alter column credential_id drop not null;

-- ── organizations: per-org digest config ─────────────────────────────────
alter table public.organizations
  add column if not exists invoice_digest_enabled          boolean       not null default false,
  add column if not exists invoice_digest_time             time          not null default '09:00:00',
  add column if not exists invoice_digest_timezone         text          not null default 'Asia/Kolkata',
  add column if not exists invoice_digest_recipient_emails text[]        not null default array[]::text[],
  add column if not exists invoice_digest_last_sent_at     timestamptz;

-- ── Cron tick (every 15 min) ────────────────────────────────────────────
create or replace function public.invoice_digest_tick()
returns void
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_jwt text;
  v_run_id uuid;
begin
  insert into public.cron_runs(name) values ('invoice_digest_tick') returning id into v_run_id;

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
      url := 'http://kong:8000/functions/v1/invoice-digest-check',
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

revoke all on function public.invoice_digest_tick() from public, anon, authenticated;

do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'invoice_digest_tick'
  loop perform cron.unschedule(j.jobid); end loop;
end$$;

select cron.schedule(
  'invoice_digest_tick',
  '*/15 * * * *',           -- every 15 minutes
  $$ select public.invoice_digest_tick(); $$
);
