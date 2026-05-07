-- Data retention. activity_logs and system_metrics grow unbounded; this migration adds:
--   1. A purge function that admins can run anytime.
--   2. A pg_cron schedule (daily at 03:00 UTC) IF the pg_cron extension is enabled in the project.
--      Supabase pg_cron is on the project's "extensions" page — enable it before running this.
--      If pg_cron isn't enabled, the schedule call is wrapped in a guard and skipped silently.

-- Purge function. Defaults: 90 days for activity_logs, 30 days for system_metrics.
-- Override at call time: select public.trackforce_purge_old_data(180, 60);
create or replace function public.trackforce_purge_old_data(
  p_activity_keep_days int default 90,
  p_metrics_keep_days  int default 30
) returns table (activity_deleted bigint, metrics_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity bigint;
  v_metrics  bigint;
begin
  delete from public.activity_logs
   where created_at < (now() - (p_activity_keep_days || ' days')::interval);
  get diagnostics v_activity = row_count;

  delete from public.system_metrics
   where recorded_at < (now() - (p_metrics_keep_days || ' days')::interval);
  get diagnostics v_metrics = row_count;

  return query select v_activity, v_metrics;
end;
$$;

-- Optional: schedule daily at 03:00 UTC if pg_cron is available.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'trackforce-purge-old-data',
      '0 3 * * *',
      $cron$select public.trackforce_purge_old_data();$cron$
    );
  else
    raise notice 'pg_cron not enabled — purge function created but not scheduled. Enable pg_cron then call cron.schedule manually.';
  end if;
exception when undefined_table or undefined_function then
  raise notice 'pg_cron schema not accessible — schedule manually after enabling the extension.';
end;
$$;

-- Storage cleanup is *not* automatic. Screenshots stay in the bucket; if you want them purged
-- alongside activity_logs, add a Storage Lifecycle rule in the Supabase dashboard or extend this
-- function with a delete loop over storage.objects (requires service role).
