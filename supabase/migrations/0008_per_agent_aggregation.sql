-- Per-agent aggregation for the Performance Reports and Reports pages.
-- Same weighting math as org_productivity_stats, broken out per agent so the dashboard can rank
-- and group without pulling raw rows.

create or replace function public.org_productivity_per_agent(
  p_org_id uuid,
  p_since timestamptz
) returns table (
  agent_id uuid,
  active_seconds bigint,
  weighted_seconds numeric,
  idle_seconds bigint,
  app_switches bigint,
  browser_events bigint,
  screenshots bigint,
  alerts_count bigint
) language sql stable as $$
  with org_agents as (
    select id from public.agents where org_id = p_org_id
  ),
  rows as (
    select
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
      and al.created_at >= p_since
  ),
  weighted as (
    select
      r.agent_id,
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
  ),
  alert_counts as (
    select agent_id, count(*)::bigint as cnt
    from public.alerts
    where agent_id in (select id from org_agents)
      and created_at >= p_since
    group by agent_id
  )
  select
    a.id,
    coalesce(sum(case when w.activity_type in ('app','browser') and w.duration > 0 then w.duration else 0 end), 0)::bigint,
    coalesce(sum(case when w.activity_type in ('app','browser') and w.duration > 0 then w.duration * w.wt else 0 end), 0)::numeric,
    coalesce(sum(case when w.activity_type = 'idle' and w.duration > 0 then w.duration else 0 end), 0)::bigint,
    coalesce(sum(case when w.activity_type = 'app' then 1 else 0 end), 0)::bigint,
    coalesce(sum(case when w.activity_type = 'browser' then 1 else 0 end), 0)::bigint,
    coalesce(sum(case when w.activity_type = 'screenshot' then 1 else 0 end), 0)::bigint,
    coalesce((select cnt from alert_counts ac where ac.agent_id = a.id), 0)::bigint
  from public.agents a
  left join weighted w on w.agent_id = a.id
  where a.org_id = p_org_id
  group by a.id;
$$;
