-- 0033_directory_sync_cron.sql
-- Auto-fire the directory-sync edge function every 5 minutes so changes on
-- the M365 / Google side flow into Rudrans without anyone clicking "Sync now".
-- Uses pg_cron + pg_net. The service-role JWT lives in Supabase Vault so it
-- can be rotated without rewriting this cron job.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
-- pg_net puts http_post in `net` schema (not extensions). Reference fully.

-- Store the service-role key in Vault if it isn't already there. The CLI / a
-- one-time admin will populate `directory_sync_service_role_jwt` via
-- `select vault.create_secret('<jwt>', 'directory_sync_service_role_jwt');`
-- before this cron runs successfully. We don't insert it here because the
-- migration file is committed to git.

-- The cron job that fires every 5 min. Reads the secret at run time so
-- rotations take effect without altering the schedule.
create or replace function public.directory_sync_tick()
returns void
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_jwt text;
  v_url text;
begin
  -- Look up the service-role JWT from Supabase Vault.
  select decrypted_secret into v_jwt
    from vault.decrypted_secrets
   where name = 'directory_sync_service_role_jwt'
   limit 1;

  if v_jwt is null then
    -- No secret configured yet — silently no-op. Run once:
    --   select vault.create_secret('<service-role-jwt>', 'directory_sync_service_role_jwt');
    return;
  end if;

  v_url := 'https://ttjazaxjhzvrzhptrpmd.supabase.co/functions/v1/directory-sync';

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_jwt,
      'Content-Type', 'application/json'
    )::jsonb,
    body := jsonb_build_object('scheduled', true)
  );
end$$;

revoke all on function public.directory_sync_tick() from public, anon, authenticated;

-- Unschedule any previous version so re-running is idempotent.
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname = 'directory_sync_tick'
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end$$;

select cron.schedule(
  'directory_sync_tick',
  '*/5 * * * *',
  $$ select public.directory_sync_tick(); $$
);
