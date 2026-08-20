-- Department-scoped productivity rules.
--
-- productivity_rules was org-wide: one category per (match_type, pattern) for
-- the whole organisation. That cannot express the thing the feature exists for
-- — youtube.com is productive for a Content team and unproductive for IT — so
-- a rule gains an optional department.
--
-- WHY department IS text AND NOT A FOREIGN KEY to org_departments:
-- agents.department is already free text with no FK, and real data does not
-- line up with the department list. On the machine this was built against the
-- only agent had department = 'IT' while org_departments contained HR,
-- Support, Engineering and Sales. Keying rules to org_departments.id would
-- therefore have silently classified nothing for that agent. Matching the
-- column that actually decides an agent's department keeps the feature working
-- on the data as it exists; tightening both into a real FK is a separate
-- data-cleanup migration.
--
-- NULL department = applies to every department. Every pre-existing row is
-- left NULL, so this migration does not move a single productivity number on
-- deploy — behaviour only changes once someone adds a department override.

ALTER TABLE public.productivity_rules
  ADD COLUMN IF NOT EXISTS department text;

-- The old key was (org_id, match_type, pattern), which now has to admit one
-- row per department plus one fallback.
--
-- NULLS NOT DISTINCT is essential (and needs PG 15+; this runs on 17.6).
-- Under the default NULLS DISTINCT, every NULL is considered unique, so the
-- org-wide fallback for a given pattern could be inserted an unlimited number
-- of times and the lookup's LIMIT 1 would pick between duplicates
-- arbitrarily.
ALTER TABLE public.productivity_rules
  DROP CONSTRAINT IF EXISTS productivity_rules_org_id_match_type_pattern_key;
ALTER TABLE public.productivity_rules
  DROP CONSTRAINT IF EXISTS productivity_rules_scope_key;
ALTER TABLE public.productivity_rules
  ADD CONSTRAINT productivity_rules_scope_key
  UNIQUE NULLS NOT DISTINCT (org_id, match_type, pattern, department);

-- Supports the per-row lookup in the RPCs below, which filters on org_id and
-- then on department.
CREATE INDEX IF NOT EXISTS productivity_rules_org_dept_idx
  ON public.productivity_rules (org_id, department);

COMMENT ON COLUMN public.productivity_rules.department IS
  'Department this rule applies to, matching agents.department. NULL means the '
  'rule is the organisation-wide fallback and applies to every department. A '
  'department-specific rule outranks the fallback for agents in that '
  'department.';

-- org_productivity_daily — 1 rule join(s) made department-aware
CREATE OR REPLACE FUNCTION public.org_productivity_daily(p_org_id uuid, p_days integer DEFAULT 7, p_until timestamp with time zone DEFAULT now(), p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(day_bucket date, active_seconds bigint, weighted_seconds numeric, active_agents bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH bounds AS (
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
      END AS rule_key,
      -- The acting agent's department, so the rule lookup below can prefer a
      -- department-specific classification over the org-wide one.
      (SELECT oa.department FROM org_agents oa WHERE oa.id = al.agent_id) AS dept
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.created_at >= (SELECT first_day FROM bounds)
      AND al.created_at <  (SELECT last_day FROM bounds) + interval '1 day'
  ),
  categorized AS (
    SELECT r.day, r.agent_id, r.activity_type, r.duration, pr.category
    FROM rows r
    LEFT JOIN LATERAL (
      SELECT pr.category
      FROM public.productivity_rules pr
      WHERE pr.org_id = p_org_id
        -- A rule with NULL department is the org-wide fallback and applies to
        -- everyone; a rule naming a department applies only to that department.
        AND (pr.department IS NULL OR pr.department = r.dept)
        AND r.rule_key = (CASE
              WHEN pr.match_type = 'app'  THEN 'app:'  || lower(pr.pattern)
              WHEN pr.match_type = 'host' THEN 'host:' || lower(pr.pattern)
            END)
      -- false sorts before true, so a department-specific rule outranks the
      -- fallback. This is what makes YouTube productive for Content and
      -- unproductive for IT off one pattern plus one override.
      ORDER BY (pr.department IS NULL)
      LIMIT 1
    ) pr ON true
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

-- org_productivity_per_agent — 1 rule join(s) made department-aware
CREATE OR REPLACE FUNCTION public.org_productivity_per_agent(p_org_id uuid, p_since timestamp with time zone, p_until timestamp with time zone DEFAULT now())
 RETURNS TABLE(agent_id uuid, active_seconds bigint, weighted_seconds numeric, idle_seconds bigint, app_switches bigint, browser_events bigint, screenshots bigint, alerts_count bigint, unproductive_seconds bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH org_agents AS (
    SELECT id, department FROM public.agents WHERE org_id = p_org_id
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
      END AS rule_key,
      -- The acting agent's department, so the rule lookup below can prefer a
      -- department-specific classification over the org-wide one.
      (SELECT oa.department FROM org_agents oa WHERE oa.id = al.agent_id) AS dept
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
    LEFT JOIN LATERAL (
      SELECT pr.category
      FROM public.productivity_rules pr
      WHERE pr.org_id = p_org_id
        -- A rule with NULL department is the org-wide fallback and applies to
        -- everyone; a rule naming a department applies only to that department.
        AND (pr.department IS NULL OR pr.department = r.dept)
        AND r.rule_key = (CASE
              WHEN pr.match_type = 'app'  THEN 'app:'  || lower(pr.pattern)
              WHEN pr.match_type = 'host' THEN 'host:' || lower(pr.pattern)
            END)
      -- false sorts before true, so a department-specific rule outranks the
      -- fallback. This is what makes YouTube productive for Content and
      -- unproductive for IT off one pattern plus one override.
      ORDER BY (pr.department IS NULL)
      LIMIT 1
    ) pr ON true
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

-- org_productivity_stats — 1 rule join(s) made department-aware
CREATE OR REPLACE FUNCTION public.org_productivity_stats(p_org_id uuid, p_since timestamp with time zone)
 RETURNS TABLE(active_seconds bigint, weighted_seconds numeric, idle_seconds bigint, app_switches bigint, browser_events bigint, screenshots bigint, alerts_count bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH org_agents AS (
    SELECT id, department FROM public.agents WHERE org_id = p_org_id
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
      END AS rule_key,
      -- The acting agent's department, so the rule lookup below can prefer a
      -- department-specific classification over the org-wide one.
      (SELECT oa.department FROM org_agents oa WHERE oa.id = al.agent_id) AS dept
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.created_at >= p_since
  ),
  categorized AS (
    SELECT r.activity_type, r.duration, pr.category
    FROM rows r
    LEFT JOIN LATERAL (
      SELECT pr.category
      FROM public.productivity_rules pr
      WHERE pr.org_id = p_org_id
        -- A rule with NULL department is the org-wide fallback and applies to
        -- everyone; a rule naming a department applies only to that department.
        AND (pr.department IS NULL OR pr.department = r.dept)
        AND r.rule_key = (CASE
              WHEN pr.match_type = 'app'  THEN 'app:'  || lower(pr.pattern)
              WHEN pr.match_type = 'host' THEN 'host:' || lower(pr.pattern)
            END)
      -- false sorts before true, so a department-specific rule outranks the
      -- fallback. This is what makes YouTube productive for Content and
      -- unproductive for IT off one pattern plus one override.
      ORDER BY (pr.department IS NULL)
      LIMIT 1
    ) pr ON true
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
$function$;

NOTIFY pgrst, 'reload schema';
