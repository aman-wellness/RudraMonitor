-- 0145_org_productivity_daily_definer.sql
--
-- FIX: the Reports "Productivity trend" chart was empty for any range wider
-- than a single day. Root cause (reproduced by calling the RPC as the
-- `authenticated` role with a minted JWT): the call fails with
--   57014: canceling statement due to statement timeout
-- which the hook surfaces as zero rows, i.e. "No data". (days=1 finished in
-- time, which is why only the single-day view ever worked.)
--
-- WHY it timed out: the function categorised EVERY activity_logs row by calling
-- resolve_rule_category() in a LEFT JOIN LATERAL — once per row. That helper
-- scans productivity_rules with LIKE-based matching (suffix / substring), which
-- cannot use an index, so each call is a full scan of the org's rules. Over a
-- multi-day window that is thousands of scans and blows past the statement
-- timeout. Measured: ~1 ms per activity row.
--
-- FIX, two parts:
--   1. SECURITY DEFINER (owner = postgres, BYPASSRLS) + SET row_security = off
--      so the aggregation reads the base tables without per-row RLS overhead,
--      plus an explicit org-membership `authz` guard so making it DEFINER does
--      not become an IDOR: a caller only ever gets an org's numbers if they
--      belong to that org (or are the service role).
--   2. Resolve each DISTINCT (dept, kind, subject) exactly once in a CTE and
--      join the rows to it, instead of calling resolve_rule_category per row.
--      The number of distinct apps/hosts is tiny and near-constant, so the
--      expensive rule matching runs a handful of times regardless of how many
--      activity rows or days are in the window. This is what makes it scale on
--      production data. The downstream aggregation is byte-for-byte the same,
--      so the returned numbers are unchanged.
--
-- resolve_rule_category itself is untouched — other callers still use it.

CREATE OR REPLACE FUNCTION public.org_productivity_daily(
  p_org_id uuid,
  p_days integer DEFAULT 7,
  p_until timestamptz DEFAULT now(),
  p_agent_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(day_bucket date, active_seconds bigint, weighted_seconds numeric, active_agents bigint)
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
  bounds AS (
    SELECT date_trunc('day', p_until) AS last_day,
           date_trunc('day', p_until) - ((greatest(p_days, 1) - 1) * interval '1 day') AS first_day
  ),
  date_series AS (
    SELECT generate_series((SELECT first_day FROM bounds), (SELECT last_day FROM bounds), interval '1 day')::date AS day
  ),
  org_agents AS (
    SELECT id, department FROM public.agents
    WHERE org_id = p_org_id
      AND (p_agent_id IS NULL OR id = p_agent_id)
  ),
  rows AS (
    SELECT
      date_trunc('day', al.created_at)::date AS day,
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
      AND al.created_at >= (SELECT first_day FROM bounds)
      AND al.created_at <  (SELECT last_day FROM bounds) + interval '1 day'
      AND (SELECT ok FROM authz)
  ),
  -- Resolve the rule category ONCE per distinct app/host (not per row).
  resolved AS (
    SELECT s.dept, s.kind, s.subject,
           coalesce(public.resolve_rule_category(p_org_id, s.dept, s.kind, s.subject), 'unproductive') AS category
    FROM (SELECT DISTINCT dept, kind, subject FROM rows WHERE kind IS NOT NULL) s
  ),
  categorized AS (
    SELECT r.day, r.agent_id, r.activity_type, r.duration,
           coalesce(rr.category, 'unproductive') AS category
    FROM rows r
    LEFT JOIN resolved rr
      ON rr.kind = r.kind
     AND rr.subject = r.subject
     AND rr.dept IS NOT DISTINCT FROM r.dept
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
$function$;

REVOKE EXECUTE ON FUNCTION public.org_productivity_daily(uuid, integer, timestamptz, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.org_productivity_daily(uuid, integer, timestamptz, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
