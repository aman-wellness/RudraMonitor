-- 0139_tool_runs_stale_reaper.sql
--
-- Auto-cancel tool_runs rows stuck in 'pending' or 'running' longer than
-- they could reasonably take. Prior state: a row could sit at pending
-- forever if the realtime broadcast missed the agent (WSS reconnect
-- window, agent offline at broadcast time), and the unique partial index
-- on (agent_id) where state in ('pending','running') would then block
-- every future run on that agent — user sees "another tool run is already
-- pending" on the dashboard and nothing works until an admin manually
-- UPDATEs the row.
--
-- Fix: a lightweight cron job (pg_cron) that runs every 5 minutes and
-- transitions abandoned rows to 'cancelled'. Thresholds:
--   pending  → 5 min  (agent should have ACK'd via `running` ping by now)
--   running  → 60 min (Windows Optimizer's 45-min hard timeout + buffer)
--
-- Idempotent: if pg_cron isn't installed (self-hosted setups may skip
-- the extension), the DO block silently no-ops.

BEGIN;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Drop any prior schedule under the same name (idempotent redeploy).
    perform cron.unschedule('tool_runs_reap_stale')
      where exists (select 1 from cron.job where jobname = 'tool_runs_reap_stale');
  end if;
end$$;

create or replace function public.reap_stale_tool_runs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n_cancelled integer;
begin
  with reaped as (
    update public.tool_runs
    set    state        = 'cancelled',
           completed_at = now(),
           stdout_tail  = coalesce(stdout_tail, '') ||
             case
               when state = 'pending'
                 then E'\n[reaper] agent never acknowledged the tool.run broadcast within 5 min — likely offline or WSS not subscribed at broadcast time.'
               else E'\n[reaper] agent started the run but never posted a completion within 60 min — either the process crashed or the endpoint disappeared.'
             end
    where  (state = 'pending' and created_at < now() - interval '5 minutes')
       or  (state = 'running' and coalesce(started_at, created_at) < now() - interval '60 minutes')
    returning 1
  )
  select count(*) into n_cancelled from reaped;
  return n_cancelled;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'tool_runs_reap_stale',
      '*/5 * * * *',
      $cmd$select public.reap_stale_tool_runs()$cmd$
    );
  end if;
end$$;

COMMIT;
