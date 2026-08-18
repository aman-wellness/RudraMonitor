-- Add an upper time bound (p_until) to org_productivity_per_agent so the
-- Reports "Custom Range" can request an explicit from/to window instead of
-- only a lookback-to-now. p_until defaults to now(), so every existing
-- 2-arg caller (agents page, performance-reports) is unaffected.
DROP FUNCTION IF EXISTS public.org_productivity_per_agent(uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.org_productivity_per_agent(
  p_org_id uuid,
  p_since  timestamptz,
  p_until  timestamptz DEFAULT now()
)
 RETURNS TABLE(agent_id uuid, active_seconds bigint, weighted_seconds numeric, idle_seconds bigint, app_switches bigint, browser_events bigint, screenshots bigint, alerts_count bigint, unproductive_seconds bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH org_agents AS (
    SELECT id FROM public.agents WHERE org_id = p_org_id
  ),
  rows AS (
    SELECT
      al.agent_id,
      al.activity_type,
      al.duration,
      CASE
        WHEN al.activity_type = 'app' THEN 'app:' || lower(coalesce(al.application_name, ''))
        WHEN al.activity_type = 'browser' THEN
          'host:' || lower(coalesce(
            (regexp_match(coalesce(al.url, ''),
              '(?:https?://)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)',
              'i'))[1],
            al.url, ''
          ))
        ELSE ''
      END AS rule_key
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.created_at >= p_since
      AND al.created_at <= p_until
  ),
  categorized AS (
    SELECT
      r.agent_id,
      r.activity_type,
      r.duration,
      pr.category
    FROM rows r
    LEFT JOIN public.productivity_rules pr
      ON pr.org_id = p_org_id
     AND r.rule_key = (CASE
            WHEN pr.match_type = 'app'  THEN 'app:'  || lower(pr.pattern)
            WHEN pr.match_type = 'host' THEN 'host:' || lower(pr.pattern)
          END)
  ),
  alert_counts AS (
    SELECT agent_id, count(*)::bigint AS cnt
    FROM public.alerts
    WHERE agent_id IN (SELECT id FROM org_agents)
      AND created_at >= p_since
      AND created_at <= p_until
    GROUP BY agent_id
  )
  SELECT
    a.id,
    coalesce(sum(CASE WHEN c.activity_type IN ('app','browser') AND c.duration > 0
                      THEN c.duration ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN c.activity_type IN ('app','browser') AND c.duration > 0
                       AND c.category = 'productive'
                      THEN c.duration ELSE 0 END), 0)::numeric,
    coalesce(sum(CASE WHEN c.activity_type = 'idle' AND c.duration > 0
                      THEN c.duration ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN c.activity_type = 'app'     THEN 1 ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN c.activity_type = 'browser' THEN 1 ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN c.activity_type = 'screenshot' THEN 1 ELSE 0 END), 0)::bigint,
    coalesce((SELECT cnt FROM alert_counts ac WHERE ac.agent_id = a.id), 0)::bigint,
    coalesce(sum(CASE WHEN c.activity_type IN ('app','browser') AND c.duration > 0
                       AND c.category = 'unproductive'
                      THEN c.duration ELSE 0 END), 0)::bigint
  FROM public.agents a
  LEFT JOIN categorized c ON c.agent_id = a.id
  WHERE a.org_id = p_org_id
  GROUP BY a.id;
$function$;
