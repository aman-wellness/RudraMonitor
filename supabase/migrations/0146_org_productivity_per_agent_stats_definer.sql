-- 0146_org_productivity_per_agent_stats_definer.sql
--
-- FIX: the Reports per-agent table (and its Avg Productivity / Total Active
-- Hours / High Performers cards) and the dashboard productivity summary all
-- showed 0 for every agent in production, even though each agent's detail page
-- showed real activity for the same day.
--
-- ROOT CAUSE: identical to migration 0145. Both org_productivity_per_agent and
-- org_productivity_stats classified every activity_logs row through
-- resolve_rule_category() in a LEFT JOIN LATERAL — once per row. That helper
-- scans productivity_rules with LIKE matching (no usable index), so as the
-- `authenticated` role over a real dataset the statement exceeds the API
-- statement timeout (Postgres 57014). The frontend hooks
-- (useProductivityPerAgent / useOrgProductivityStats) swallow that error and
-- leave the result empty, which renders as "all zeros" rather than an error.
-- 0145 fixed the sibling trend function but left these two untouched.
--
-- FIX (mirrors 0145):
--   1. SECURITY DEFINER (owner = postgres, BYPASSRLS) + SET row_security = off,
--      with an explicit org-membership `authz` guard so this cannot become an
--      IDOR now that RLS no longer scopes the rows.
--   2. Resolve each DISTINCT (dept, kind, subject) exactly once in a CTE and
--      join rows to it, instead of calling resolve_rule_category per row, so
--      the expensive rule matching runs a handful of times regardless of how
--      many activity rows are in the window. The downstream aggregation is
--      unchanged, so the returned numbers are identical.

-- ============================ per-agent table ============================
CREATE OR REPLACE FUNCTION public.org_productivity_per_agent(
  p_org_id uuid,
  p_since timestamp with time zone,
  p_until timestamp with time zone DEFAULT now()
)
 RETURNS TABLE(agent_id uuid, active_seconds bigint, weighted_seconds numeric, idle_seconds bigint, app_switches bigint, browser_events bigint, screenshots bigint, alerts_count bigint, unproductive_seconds bigint)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
 SET row_security = off
AS $function$
  WITH authz AS (
    SELECT (
      auth.role() = 'service_role'
      OR EXISTS (
        SELECT 1 FROM public.org_members m
        WHERE m.user_id = auth.uid() AND m.org_id = p_org_id
      )
    ) AS ok
  ),
  org_agents AS (
    SELECT id, department FROM public.agents WHERE org_id = p_org_id
  ),
  rows AS (
    SELECT
      al.agent_id,
      al.activity_type,
      al.duration,
      CASE al.activity_type WHEN 'app' THEN 'app' WHEN 'browser' THEN 'host' END AS kind,
      CASE
        WHEN al.activity_type = 'app' THEN lower(coalesce(al.application_name, ''))
        WHEN al.activity_type = 'browser' THEN
          lower(coalesce(
            (regexp_match(coalesce(al.url, ''),
              '(?:https?://)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)',
              'i'))[1],
            al.url, ''
          ))
        ELSE ''
      END AS subject,
      (SELECT oa.department FROM org_agents oa WHERE oa.id = al.agent_id) AS dept
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.created_at >= p_since
      AND al.created_at <= p_until
      AND (SELECT ok FROM authz)
  ),
  -- Resolve the rule category ONCE per distinct app/host (not per row).
  resolved AS (
    SELECT s.dept, s.kind, s.subject,
           coalesce(public.resolve_rule_category(p_org_id, s.dept, s.kind, s.subject), 'unproductive') AS category
    FROM (SELECT DISTINCT dept, kind, subject FROM rows WHERE kind IS NOT NULL) s
  ),
  categorized AS (
    SELECT
      r.agent_id,
      r.activity_type,
      r.duration,
      coalesce(rr.category, 'unproductive') AS category
    FROM rows r
    LEFT JOIN resolved rr
      ON rr.kind = r.kind
     AND rr.subject = r.subject
     AND rr.dept IS NOT DISTINCT FROM r.dept
  ),
  alert_counts AS (
    SELECT agent_id, count(*)::bigint AS cnt
    FROM public.alerts
    WHERE agent_id IN (SELECT id FROM org_agents)
      AND created_at >= p_since
      AND created_at <= p_until
      AND (SELECT ok FROM authz)
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
                       AND c.category IN ('unproductive', 'prohibited')
                      THEN c.duration ELSE 0 END), 0)::bigint
  FROM public.agents a
  LEFT JOIN categorized c ON c.agent_id = a.id
  WHERE a.org_id = p_org_id
    AND (SELECT ok FROM authz)
  GROUP BY a.id;
$function$;

-- ============================ dashboard summary ============================
CREATE OR REPLACE FUNCTION public.org_productivity_stats(
  p_org_id uuid,
  p_since timestamp with time zone
)
 RETURNS TABLE(active_seconds bigint, weighted_seconds numeric, idle_seconds bigint, app_switches bigint, browser_events bigint, screenshots bigint, alerts_count bigint)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
 SET row_security = off
AS $function$
  WITH authz AS (
    SELECT (
      auth.role() = 'service_role'
      OR EXISTS (
        SELECT 1 FROM public.org_members m
        WHERE m.user_id = auth.uid() AND m.org_id = p_org_id
      )
    ) AS ok
  ),
  org_agents AS (
    SELECT id, department FROM public.agents WHERE org_id = p_org_id
  ),
  rows AS (
    SELECT al.agent_id, al.activity_type, al.duration,
      CASE al.activity_type WHEN 'app' THEN 'app' WHEN 'browser' THEN 'host' END AS kind,
      CASE
        WHEN al.activity_type = 'app' THEN lower(coalesce(al.application_name, ''))
        WHEN al.activity_type = 'browser' THEN
          lower(coalesce(
            (regexp_match(coalesce(al.url, ''),
              '(?:https?://)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)',
              'i'))[1],
            al.url, ''
          ))
        ELSE ''
      END AS subject,
      (SELECT oa.department FROM org_agents oa WHERE oa.id = al.agent_id) AS dept
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.created_at >= p_since
      AND (SELECT ok FROM authz)
  ),
  resolved AS (
    SELECT s.dept, s.kind, s.subject,
           coalesce(public.resolve_rule_category(p_org_id, s.dept, s.kind, s.subject), 'unproductive') AS category
    FROM (SELECT DISTINCT dept, kind, subject FROM rows WHERE kind IS NOT NULL) s
  ),
  categorized AS (
    SELECT r.activity_type, r.duration, coalesce(rr.category, 'unproductive') AS category
    FROM rows r
    LEFT JOIN resolved rr
      ON rr.kind = r.kind
     AND rr.subject = r.subject
     AND rr.dept IS NOT DISTINCT FROM r.dept
  )
  SELECT
    coalesce(sum(CASE WHEN activity_type IN ('app','browser') AND duration > 0
                      THEN duration ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN activity_type IN ('app','browser') AND duration > 0
                       AND category = 'productive'
                      THEN duration ELSE 0 END), 0)::numeric,
    coalesce(sum(CASE WHEN activity_type = 'idle' AND duration > 0
                      THEN duration ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN activity_type = 'app'     THEN 1 ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN activity_type = 'browser' THEN 1 ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN activity_type = 'screenshot' THEN 1 ELSE 0 END), 0)::bigint,
    (SELECT count(*)::bigint FROM public.alerts
     WHERE agent_id IN (SELECT id FROM org_agents) AND created_at >= p_since
       AND (SELECT ok FROM authz))
  FROM categorized;
$function$;

-- Lock down + expose exactly like 0145's function.
REVOKE EXECUTE ON FUNCTION public.org_productivity_per_agent(uuid, timestamptz, timestamptz) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.org_productivity_per_agent(uuid, timestamptz, timestamptz) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.org_productivity_stats(uuid, timestamptz) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.org_productivity_stats(uuid, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
