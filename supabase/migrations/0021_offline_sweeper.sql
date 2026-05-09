-- 0021_offline_sweeper.sql
-- Periodically reconcile agents.status with last_active reality.
--
-- Why: the agent posts heartbeats every 60s and tags itself online/idle. When
-- the laptop is suspended / network drops / process is killed, the heartbeat
-- stops but the stored `status` is stuck at whatever it was last set to —
-- typically "online". The dashboard's read-side computation already overrides
-- this for display, but reports / SQL queries / aggregation jobs that read
-- agents.status directly would still show stale-online agents.
--
-- This sweeper runs every minute via pg_cron, marking agents whose last_active
-- is > 150 seconds old as 'offline'. Mirrors the dashboard's threshold.

create extension if not exists pg_cron with schema extensions;

create or replace function public.sweep_offline_agents()
returns void language sql as $$
  update public.agents
    set status = 'offline'
    where status <> 'offline'
      and (last_active is null or last_active < now() - interval '150 seconds');
$$;

-- Idempotent registration of the cron job (every minute).
do $$
begin
  -- Drop old job if it exists (rename-safe)
  perform cron.unschedule('trackforce-offline-sweeper')
    where exists (select 1 from cron.job where jobname = 'trackforce-offline-sweeper');
exception when others then null;
end $$;

select cron.schedule(
  'trackforce-offline-sweeper',
  '* * * * *',                          -- every minute
  $$ select public.sweep_offline_agents(); $$
);
