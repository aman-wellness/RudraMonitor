-- Dashboard aggregates: hourly fleet activity + top applications.
--
-- Both power the redesigned customer Dashboard ("Workforce Activity" chart
-- and the "Top Applications" panel). They exist so the browser never has to
-- download a day's worth of activity_logs just to bucket it — at 200 agents
-- that's tens of thousands of rows per page load.
--
-- Security invoker (same as the other org_* aggregation RPCs in 0007/0118):
-- RLS on activity_logs still applies, so passing another org's id returns
-- nothing.
--
-- The frontend falls back to client-side aggregation when these functions
-- are missing, so deploying the app before this migration degrades to
-- "approximate over the last N rows" rather than breaking.

BEGIN;

-- =============================================================================
-- org_activity_hourly(p_org_id, p_hours)
--   One row per hour bucket for the last p_hours, gap-filled so the chart
--   always has a continuous x-axis even for hours with zero activity.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.org_activity_hourly(
  p_org_id uuid,
  p_hours  int DEFAULT 24
) RETURNS TABLE (
  hour_bucket    timestamptz,
  active_seconds bigint,
  active_agents  bigint
)
LANGUAGE sql STABLE
AS $$
  WITH buckets AS (
    SELECT generate_series(
      date_trunc('hour', now()) - ((greatest(p_hours, 1) - 1) * interval '1 hour'),
      date_trunc('hour', now()),
      interval '1 hour'
    ) AS h
  ),
  org_agents AS (
    SELECT id FROM public.agents WHERE org_id = p_org_id
  ),
  rows AS (
    SELECT
      date_trunc('hour', al.created_at) AS h,
      al.agent_id,
      al.activity_type,
      al.duration
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.created_at >= date_trunc('hour', now())
                           - ((greatest(p_hours, 1) - 1) * interval '1 hour')
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
-- org_agent_hourly(p_org_id, p_hours)
--   Per-agent hourly activity, for the presence strips in the agent table.
--   Not gap-filled (the client only needs the hours that have data), so this
--   stays small even for a big fleet.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.org_agent_hourly(
  p_org_id uuid,
  p_hours  int DEFAULT 24
) RETURNS TABLE (
  agent_id       uuid,
  hour_bucket    timestamptz,
  active_seconds bigint
)
LANGUAGE sql STABLE
AS $$
  SELECT
    al.agent_id,
    date_trunc('hour', al.created_at),
    coalesce(sum(CASE WHEN al.duration > 0 THEN al.duration ELSE 0 END), 0)::bigint
  FROM public.activity_logs al
  WHERE al.agent_id IN (SELECT id FROM public.agents WHERE org_id = p_org_id)
    AND al.created_at >= date_trunc('hour', now())
                         - ((greatest(p_hours, 1) - 1) * interval '1 hour')
    AND al.activity_type IN ('app', 'browser')
  GROUP BY 1, 2;
$$;

-- =============================================================================
-- org_top_applications(p_org_id, p_since, p_limit)
--   Foreground application time, biggest first. Only `app` rows — browser
--   rows are excluded on purpose so Chrome's own focus time isn't counted
--   twice (once as the app, once per visited host).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.org_top_applications(
  p_org_id uuid,
  p_since  timestamptz,
  p_limit  int DEFAULT 6
) RETURNS TABLE (
  app_name text,
  seconds  bigint,
  events   bigint
)
LANGUAGE sql STABLE
AS $$
  WITH org_agents AS (
    SELECT id FROM public.agents WHERE org_id = p_org_id
  )
  SELECT
    al.application_name::text,
    coalesce(sum(CASE WHEN al.duration > 0 THEN al.duration ELSE 0 END), 0)::bigint,
    count(*)::bigint
  FROM public.activity_logs al
  WHERE al.agent_id IN (SELECT id FROM org_agents)
    AND al.created_at >= p_since
    AND al.activity_type = 'app'
    AND coalesce(al.application_name, '') <> ''
  GROUP BY al.application_name
  ORDER BY 2 DESC, 3 DESC
  LIMIT greatest(p_limit, 1);
$$;

COMMIT;
