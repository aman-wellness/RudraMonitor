-- org_app_usage — server-side aggregation for Live monitoring → Applications.
--
-- The tab used to fetch RAW activity_logs rows with `limit: 200` and group them
-- in the browser. Two things were wrong with that, and both were visible on a
-- single-agent org:
--
--   1. MISSING APPLICATIONS. The limit bounds ROWS, not applications, and rows
--      are far from evenly distributed: of 435 app rows in 24h, `Code` alone
--      accounted for 309. The newest 200 rows therefore contained only 6 of the
--      11 applications actually used. The other five were never reachable, and
--      the header read "6 of 6" — counting what had been loaded, not what
--      existed, so the UI confidently reported a complete list that was not.
--
--   2. WRONG TOTALS. Even for an application that did appear, its duration was
--      the sum of whichever of its rows happened to fall inside the truncated
--      window. There is no limit large enough to fix this in general: a fleet
--      of 200 agents produces rows faster than any client-side page size.
--
-- Aggregating here bounds the result by (agent × application), which is the
-- grain the UI actually displays, and makes every duration a complete sum.
--
-- `department` is returned so the caller can resolve department-scoped
-- productivity rules without a second query or a client-side join against the
-- agents list.

CREATE OR REPLACE FUNCTION public.org_app_usage(
  p_org_id   uuid,
  p_since    timestamptz,
  p_until    timestamptz DEFAULT now(),
  p_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
  agent_id         uuid,
  agent_name       text,
  department       text,
  application_name text,
  window_title     text,
  total_seconds    bigint,
  events           bigint,
  last_seen        timestamptz
)
LANGUAGE sql STABLE
SECURITY INVOKER
AS $$
  WITH org_agents AS (
    SELECT a.id, a.agent_name, a.department
    FROM public.agents a
    WHERE a.org_id = p_org_id
      AND (p_agent_id IS NULL OR a.id = p_agent_id)
  ),
  app_rows AS (
    SELECT
      al.agent_id,
      al.application_name,
      al.duration,
      al.url,
      al.created_at
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.activity_type = 'app'
      AND al.application_name IS NOT NULL
      AND al.application_name <> ''
      AND al.created_at >= p_since
      AND al.created_at <  p_until
  ),
  grouped AS (
    SELECT
      r.agent_id,
      r.application_name,
      sum(coalesce(r.duration, 0))::bigint AS total_seconds,
      count(*)::bigint                     AS events,
      max(r.created_at)                    AS last_seen
    FROM app_rows r
    GROUP BY r.agent_id, r.application_name
  )
  SELECT
    g.agent_id,
    oa.agent_name,
    oa.department,
    g.application_name,
    -- Window title of the most recent sample for this app. For activity_type
    -- 'app' the agent stores the foreground window title in `url`, which is why
    -- this reads from a column named url.
    (
      SELECT r2.url
      FROM app_rows r2
      WHERE r2.agent_id = g.agent_id
        AND r2.application_name = g.application_name
        AND r2.url IS NOT NULL
        AND r2.url <> ''
      ORDER BY r2.created_at DESC
      LIMIT 1
    ) AS window_title,
    g.total_seconds,
    g.events,
    g.last_seen
  FROM grouped g
  JOIN org_agents oa ON oa.id = g.agent_id
  ORDER BY g.total_seconds DESC;
$$;

-- SECURITY INVOKER above is deliberate: the function reads activity_logs and
-- agents as the calling user, so the existing row-level policies on those
-- tables remain the only thing deciding what an org can see. A SECURITY
-- DEFINER version would have to re-implement that check correctly.
COMMENT ON FUNCTION public.org_app_usage(uuid, timestamptz, timestamptz, uuid) IS
  'Per (agent, application) foreground-time totals for a window. Aggregates '
  'server-side so the row limit bounds applications rather than raw samples — '
  'the client-side version silently dropped applications and under-reported '
  'durations whenever one busy app filled the page size.';

GRANT EXECUTE ON FUNCTION public.org_app_usage(uuid, timestamptz, timestamptz, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
