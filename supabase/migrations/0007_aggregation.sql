-- Server-side aggregation RPCs so the dashboard doesn't have to download 5000-row windows.
-- Both functions run as the caller (security invoker), so RLS still applies — passing another
-- org's id returns no rows.

-- Index to support type-filtered queries (used by Monitoring tabs).
create index if not exists activity_logs_type_time_idx
  on public.activity_logs (activity_type, created_at desc);

-- Index for alert dashboard filters (joined with agents → org).
create index if not exists alerts_resolved_time_idx
  on public.alerts (ai_resolved, created_at desc);

-- =============================================================================
-- org_productivity_stats(p_org_id, p_since)
--   Returns one row of org-wide aggregates over the time window.
-- =============================================================================
create or replace function public.org_productivity_stats(
  p_org_id uuid,
  p_since timestamptz
) returns table (
  total_active_seconds bigint,
  total_weighted_seconds numeric,
  total_idle_seconds bigint,
  total_screenshots bigint,
  pending_alerts bigint,
  online_agents bigint
) language sql stable as $$
  with org_agents as (
    select id from public.agents where org_id = p_org_id
  ),
  rows as (
    select
      al.activity_type,
      al.duration,
      case
        when al.activity_type = 'app' then 'app:' || lower(coalesce(al.application_name, ''))
        when al.activity_type = 'browser' then
          'host:' || lower(coalesce(
            (regexp_match(coalesce(al.url, ''),
              '(?:https?://)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)',
              'i'))[1],
            al.url, ''
          ))
        else ''
      end as rule_key
    from public.activity_logs al
    where al.agent_id in (select id from org_agents)
      and al.created_at >= p_since
  ),
  weighted as (
    select
      r.activity_type,
      r.duration,
      case
        when pr.category = 'productive' then 1.0
        when pr.category = 'unproductive' then 0.0
        else 0.5
      end as wt
    from rows r
    left join public.productivity_rules pr
      on pr.org_id = p_org_id
     and r.rule_key = (case
            when pr.match_type = 'app' then 'app:' || lower(pr.pattern)
            when pr.match_type = 'host' then 'host:' || lower(pr.pattern)
          end)
  )
  select
    coalesce(sum(case when activity_type in ('app','browser') and duration > 0 then duration else 0 end), 0)::bigint,
    coalesce(sum(case when activity_type in ('app','browser') and duration > 0 then duration * wt else 0 end), 0)::numeric,
    coalesce(sum(case when activity_type = 'idle' and duration > 0 then duration else 0 end), 0)::bigint,
    coalesce(sum(case when activity_type = 'screenshot' then 1 else 0 end), 0)::bigint,
    (select count(*) from public.alerts a
       where a.agent_id in (select id from org_agents)
         and a.created_at >= p_since
         and not a.ai_resolved)::bigint,
    (select count(*) from public.agents
       where org_id = p_org_id and status = 'online')::bigint
  from weighted;
$$;

-- =============================================================================
-- org_productivity_daily(p_org_id, p_days)
--   Returns one row per day for the last p_days days. Used by the dashboard
--   weekly chart and Performance Reports trend tab.
-- =============================================================================
create or replace function public.org_productivity_daily(
  p_org_id uuid,
  p_days int default 7
) returns table (
  day_bucket date,
  active_seconds bigint,
  weighted_seconds numeric,
  active_agents bigint
) language sql stable as $$
  with date_series as (
    select generate_series(
      (date_trunc('day', now()) - ((p_days - 1) * interval '1 day'))::date,
      date_trunc('day', now())::date,
      interval '1 day'
    )::date as day
  ),
  org_agents as (
    select id from public.agents where org_id = p_org_id
  ),
  rows as (
    select
      date_trunc('day', al.created_at)::date as day,
      al.agent_id,
      al.activity_type,
      al.duration,
      case
        when al.activity_type = 'app' then 'app:' || lower(coalesce(al.application_name, ''))
        when al.activity_type = 'browser' then
          'host:' || lower(coalesce(
            (regexp_match(coalesce(al.url, ''),
              '(?:https?://)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)',
              'i'))[1],
            al.url, ''
          ))
        else ''
      end as rule_key
    from public.activity_logs al
    where al.agent_id in (select id from org_agents)
      and al.created_at >= date_trunc('day', now()) - ((p_days - 1) * interval '1 day')
  ),
  weighted as (
    select
      r.day, r.agent_id, r.activity_type, r.duration,
      case
        when pr.category = 'productive' then 1.0
        when pr.category = 'unproductive' then 0.0
        else 0.5
      end as wt
    from rows r
    left join public.productivity_rules pr
      on pr.org_id = p_org_id
     and r.rule_key = (case
            when pr.match_type = 'app' then 'app:' || lower(pr.pattern)
            when pr.match_type = 'host' then 'host:' || lower(pr.pattern)
          end)
  )
  select
    ds.day,
    coalesce(sum(case when w.activity_type in ('app','browser') and w.duration > 0 then w.duration else 0 end), 0)::bigint,
    coalesce(sum(case when w.activity_type in ('app','browser') and w.duration > 0 then w.duration * w.wt else 0 end), 0)::numeric,
    count(distinct w.agent_id) filter (where w.duration > 0)::bigint
  from date_series ds
  left join weighted w on w.day = ds.day
  group by ds.day
  order by ds.day;
$$;
