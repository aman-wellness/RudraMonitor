-- Dashboard filters: every aggregate RPC gains an explicit window END and an
-- optional agent scope, so the dashboard's date-range + agent pickers can be
-- answered server-side instead of by over-fetching and filtering in the browser.
--
-- Why DROP + CREATE rather than CREATE OR REPLACE: adding a parameter changes
-- the signature, and leaving the old arity in place would make a 2-argument
-- call ambiguous between the two overloads. Dropping first keeps exactly one
-- function per name. All new parameters have defaults, so existing call sites
-- that don't pass them behave exactly as before.
--
-- p_agent_id NULL = whole org (the default).

BEGIN;

-- =============================================================================
-- org_productivity_daily(p_org_id, p_days, p_until, p_agent_id)
--   Was anchored to now(); now anchored to p_until so a historical range can be
--   requested without asking for every day since.
-- =============================================================================
DROP FUNCTION IF EXISTS public.org_productivity_daily(uuid, int);

CREATE FUNCTION public.org_productivity_daily(
  p_org_id   uuid,
  p_days     int DEFAULT 7,
  p_until    timestamptz DEFAULT now(),
  p_agent_id uuid DEFAULT NULL
) RETURNS TABLE (
  day_bucket       date,
  active_seconds   bigint,
  weighted_seconds numeric,
  active_agents    bigint
)
LANGUAGE sql STABLE
AS $$
  WITH bounds AS (
    SELECT date_trunc('day', p_until) AS last_day,
           date_trunc('day', p_until) - ((greatest(p_days, 1) - 1) * interval '1 day') AS first_day
  ),
  date_series AS (
    SELECT generate_series((SELECT first_day FROM bounds), (SELECT last_day FROM bounds), interval '1 day')::date AS day
  ),
  org_agents AS (
    SELECT id FROM public.agents
    WHERE org_id = p_org_id
      AND (p_agent_id IS NULL OR id = p_agent_id)
  ),
  rows AS (
    SELECT
      date_trunc('day', al.created_at)::date AS day,
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
      AND al.created_at >= (SELECT first_day FROM bounds)
      AND al.created_at <  (SELECT last_day FROM bounds) + interval '1 day'
  ),
  categorized AS (
    SELECT r.day, r.agent_id, r.activity_type, r.duration, pr.category
    FROM rows r
    LEFT JOIN public.productivity_rules pr
      ON pr.org_id = p_org_id
     AND r.rule_key = (CASE
            WHEN pr.match_type = 'app'  THEN 'app:'  || lower(pr.pattern)
            WHEN pr.match_type = 'host' THEN 'host:' || lower(pr.pattern)
          END)
  )
  SELECT
    ds.day,
    coalesce(sum(CASE WHEN c.activity_type IN ('app','browser') AND c.duration > 0
                      THEN c.duration ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN c.activity_type IN ('app','browser') AND c.duration > 0
                       AND c.category = 'productive'
                      THEN c.duration ELSE 0 END), 0)::numeric,
    count(DISTINCT c.agent_id) FILTER (WHERE c.duration > 0)::bigint
  FROM date_series ds
  LEFT JOIN categorized c ON c.day = ds.day
  GROUP BY ds.day
  ORDER BY ds.day;
$$;

-- =============================================================================
-- org_activity_hourly(p_org_id, p_hours, p_until, p_agent_id)
-- =============================================================================
DROP FUNCTION IF EXISTS public.org_activity_hourly(uuid, int);

CREATE FUNCTION public.org_activity_hourly(
  p_org_id   uuid,
  p_hours    int DEFAULT 24,
  p_until    timestamptz DEFAULT now(),
  p_agent_id uuid DEFAULT NULL
) RETURNS TABLE (
  hour_bucket    timestamptz,
  active_seconds bigint,
  active_agents  bigint
)
LANGUAGE sql STABLE
AS $$
  WITH bounds AS (
    SELECT date_trunc('hour', p_until) AS last_hour,
           date_trunc('hour', p_until) - ((greatest(p_hours, 1) - 1) * interval '1 hour') AS first_hour
  ),
  buckets AS (
    SELECT generate_series((SELECT first_hour FROM bounds), (SELECT last_hour FROM bounds), interval '1 hour') AS h
  ),
  org_agents AS (
    SELECT id FROM public.agents
    WHERE org_id = p_org_id
      AND (p_agent_id IS NULL OR id = p_agent_id)
  ),
  rows AS (
    SELECT
      date_trunc('hour', al.created_at) AS h,
      al.agent_id,
      al.activity_type,
      al.duration
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.created_at >= (SELECT first_hour FROM bounds)
      AND al.created_at <  (SELECT last_hour FROM bounds) + interval '1 hour'
  )
  SELECT
    b.h,
    coalesce(sum(CASE WHEN r.activity_type IN ('app','browser') AND r.duration > 0
                      THEN r.duration ELSE 0 END), 0)::bigint,
    count(DISTINCT r.agent_id) FILTER (WHERE r.duration > 0)::bigint
  FROM buckets b
  LEFT JOIN rows r ON r.h = b.h
  GROUP BY b.h
  ORDER BY b.h;
$$;

-- =============================================================================
-- org_agent_hourly(p_org_id, p_hours, p_until, p_agent_id)
-- =============================================================================
DROP FUNCTION IF EXISTS public.org_agent_hourly(uuid, int);

CREATE FUNCTION public.org_agent_hourly(
  p_org_id   uuid,
  p_hours    int DEFAULT 24,
  p_until    timestamptz DEFAULT now(),
  p_agent_id uuid DEFAULT NULL
) RETURNS TABLE (
  agent_id       uuid,
  hour_bucket    timestamptz,
  active_seconds bigint
)
LANGUAGE sql STABLE
AS $$
  WITH bounds AS (
    SELECT date_trunc('hour', p_until) AS last_hour,
           date_trunc('hour', p_until) - ((greatest(p_hours, 1) - 1) * interval '1 hour') AS first_hour
  )
  SELECT
    al.agent_id,
    date_trunc('hour', al.created_at),
    coalesce(sum(CASE WHEN al.duration > 0 THEN al.duration ELSE 0 END), 0)::bigint
  FROM public.activity_logs al
  WHERE al.agent_id IN (
          SELECT id FROM public.agents
          WHERE org_id = p_org_id AND (p_agent_id IS NULL OR id = p_agent_id)
        )
    AND al.created_at >= (SELECT first_hour FROM bounds)
    AND al.created_at <  (SELECT last_hour FROM bounds) + interval '1 hour'
    AND al.activity_type IN ('app', 'browser')
  GROUP BY 1, 2;
$$;

-- =============================================================================
-- org_top_applications(p_org_id, p_since, p_limit, p_until, p_agent_id)
-- =============================================================================
DROP FUNCTION IF EXISTS public.org_top_applications(uuid, timestamptz, int);

CREATE FUNCTION public.org_top_applications(
  p_org_id   uuid,
  p_since    timestamptz,
  p_limit    int DEFAULT 6,
  p_until    timestamptz DEFAULT now(),
  p_agent_id uuid DEFAULT NULL
) RETURNS TABLE (
  app_name text,
  seconds  bigint,
  events   bigint
)
LANGUAGE sql STABLE
AS $$
  SELECT
    al.application_name::text,
    coalesce(sum(CASE WHEN al.duration > 0 THEN al.duration ELSE 0 END), 0)::bigint,
    count(*)::bigint
  FROM public.activity_logs al
  WHERE al.agent_id IN (
          SELECT id FROM public.agents
          WHERE org_id = p_org_id AND (p_agent_id IS NULL OR id = p_agent_id)
        )
    AND al.created_at >= p_since
    AND al.created_at <= p_until
    AND al.activity_type = 'app'
    AND coalesce(al.application_name, '') <> ''
  GROUP BY al.application_name
  ORDER BY 2 DESC, 3 DESC
  LIMIT greatest(p_limit, 1);
$$;

-- =============================================================================
-- org_productivity_per_agent already takes p_since/p_until (migration 0123).
-- The dashboard scopes it to one agent client-side — it returns a row per
-- agent, so there's nothing to push down.
-- =============================================================================

COMMIT;
