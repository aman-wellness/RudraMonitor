-- Productivity aggregation fix — every agent was showing 50% because the
-- weighting had a fatal fallback.
--
-- Original math (migration 0008):
--   weight = 1.0 if productivity_rules.category = 'productive'
--            0.0 if 'unproductive'
--            0.5 otherwise (including NULL — the LEFT JOIN miss)
--   productivity_pct = weighted_seconds / active_seconds
--
-- Every org has thousands of activity rows; only a handful ever match a
-- productivity rule (most orgs don't configure rules at all, or configure
-- ~10 rules). So every non-matched row landed on the `else 0.5` branch,
-- and productivity converged to 50% for every agent for every day.
-- Customer feedback 2026-07-24: "sabki 50% aa rhi hai aise kyu".
--
-- New semantics — same shape (backwards-compat with dashboard code that
-- already reads active_seconds + weighted_seconds), different math:
--
--   productive_seconds   = sum(duration) where explicit rule = 'productive'
--   unproductive_seconds = sum(duration) where explicit rule = 'unproductive'
--   categorized_seconds  = productive + unproductive (excludes neutrals)
--   active_seconds       = sum(app+browser durations)  ← unchanged
--   weighted_seconds     = productive_seconds
--   productivity_pct     = productive / categorized  (frontend computes)
--
-- Effect:
--   • Orgs with productivity rules see productivity computed against
--     categorized time only. Uncategorized apps drop out of the ratio
--     instead of dragging every score to 50%.
--   • Orgs with no rules see productivity_pct = 0/0 → frontend treats
--     as null → shows "—" instead of misleading 50%. That's honest:
--     productivity is meaningful only when rules exist to categorize
--     time.
--   • active_seconds still reports total tracked focus time, so the
--     other columns (active hours, app switches) remain correct.

BEGIN;

-- CREATE OR REPLACE can't change a function's OUT parameter list, so
-- drop first. Safe because the RPC is called through Supabase's
-- PostgREST — no other DB-level dependencies.
DROP FUNCTION IF EXISTS public.org_productivity_per_agent(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.org_productivity_stats(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.org_productivity_daily(uuid, int);

CREATE OR REPLACE FUNCTION public.org_productivity_per_agent(
  p_org_id uuid,
  p_since  timestamptz
) RETURNS TABLE (
  agent_id             uuid,
  active_seconds       bigint,
  weighted_seconds     numeric,
  idle_seconds         bigint,
  app_switches         bigint,
  browser_events       bigint,
  screenshots          bigint,
  alerts_count         bigint,
  unproductive_seconds bigint
)
LANGUAGE sql STABLE
AS $$
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
  ),
  categorized AS (
    SELECT
      r.agent_id,
      r.activity_type,
      r.duration,
      pr.category  -- may be NULL when no rule matched
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
    GROUP BY agent_id
  )
  SELECT
    a.id,
    -- active_seconds: total app+browser focus (unchanged)
    coalesce(sum(CASE WHEN c.activity_type IN ('app','browser') AND c.duration > 0
                      THEN c.duration ELSE 0 END), 0)::bigint,
    -- weighted_seconds: only the EXPLICITLY-productive slice. Frontend
    -- divides by (productive+unproductive) if that count is available,
    -- else falls back to weighted/active. Reporting weighted = productive
    -- keeps the field compatible with existing readers while removing
    -- the neutral-0.5 contamination.
    coalesce(sum(CASE WHEN c.activity_type IN ('app','browser') AND c.duration > 0
                       AND c.category = 'productive'
                      THEN c.duration ELSE 0 END), 0)::numeric,
    -- idle_seconds: unchanged (explicit idle rows only; read side may add
    -- unfocus gaps)
    coalesce(sum(CASE WHEN c.activity_type = 'idle' AND c.duration > 0
                      THEN c.duration ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN c.activity_type = 'app'     THEN 1 ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN c.activity_type = 'browser' THEN 1 ELSE 0 END), 0)::bigint,
    coalesce(sum(CASE WHEN c.activity_type = 'screenshot' THEN 1 ELSE 0 END), 0)::bigint,
    coalesce((SELECT cnt FROM alert_counts ac WHERE ac.agent_id = a.id), 0)::bigint,
    -- unproductive_seconds: for the frontend to compute
    -- productivity_pct = productive / (productive + unproductive) and
    -- treat 0/0 as "no rules configured → show '—'".
    coalesce(sum(CASE WHEN c.activity_type IN ('app','browser') AND c.duration > 0
                       AND c.category = 'unproductive'
                      THEN c.duration ELSE 0 END), 0)::bigint
  FROM public.agents a
  LEFT JOIN categorized c ON c.agent_id = a.id
  WHERE a.org_id = p_org_id
  GROUP BY a.id;
$$;

-- Same fix for the org-wide and daily variants — both had the identical
-- 0.5-fallback bug producing 50% aggregate productivity.

CREATE OR REPLACE FUNCTION public.org_productivity_stats(
  p_org_id uuid,
  p_since  timestamptz
) RETURNS TABLE (
  active_seconds   bigint,
  weighted_seconds numeric,
  idle_seconds     bigint,
  app_switches     bigint,
  browser_events   bigint,
  screenshots      bigint,
  alerts_count     bigint
)
LANGUAGE sql STABLE
AS $$
  WITH org_agents AS (
    SELECT id FROM public.agents WHERE org_id = p_org_id
  ),
  rows AS (
    SELECT al.activity_type, al.duration,
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
  ),
  categorized AS (
    SELECT r.activity_type, r.duration, pr.category
    FROM rows r
    LEFT JOIN public.productivity_rules pr
      ON pr.org_id = p_org_id
     AND r.rule_key = (CASE
            WHEN pr.match_type = 'app'  THEN 'app:'  || lower(pr.pattern)
            WHEN pr.match_type = 'host' THEN 'host:' || lower(pr.pattern)
          END)
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
     WHERE agent_id IN (SELECT id FROM org_agents) AND created_at >= p_since)
  FROM categorized;
$$;

CREATE OR REPLACE FUNCTION public.org_productivity_daily(
  p_org_id uuid,
  p_days   int DEFAULT 7
) RETURNS TABLE (
  day_bucket       date,
  active_seconds   bigint,
  weighted_seconds numeric,
  active_agents    bigint
)
LANGUAGE sql STABLE
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (date_trunc('day', now()) - ((p_days - 1) * interval '1 day'))::date,
      date_trunc('day', now())::date,
      interval '1 day'
    )::date AS day
  ),
  org_agents AS (
    SELECT id FROM public.agents WHERE org_id = p_org_id
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
      AND al.created_at >= date_trunc('day', now()) - ((p_days - 1) * interval '1 day')
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

COMMIT;
