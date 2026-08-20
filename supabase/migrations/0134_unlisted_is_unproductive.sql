-- Unlisted activity counts as unproductive, and host rules match subdomains.
--
-- Two changes, both required for the catalogue in 0133 to mean anything.
--
-- 1. HOST RULES NOW MATCH BY SUFFIX.
--    Matching was exact string equality, so a rule for 'github.com' did not
--    apply to 'gist.github.com', and 'google.com' did not apply to
--    'docs.google.com'. Real browsing is mostly subdomains — the traffic this
--    was verified against included 'console.firebase.google.com' and
--    'eu-north-1.console.aws.amazon.com' — so an exact-match catalogue would
--    have classified almost nothing. One rule per registrable domain now covers
--    its subdomains, via `subject LIKE '%.' || pattern`. The leading dot is
--    what makes it safe: '%.github.com' cannot match 'notgithub.com'.
--
--    Because two rules can now match the same host, the lookup orders by
--    length(pattern) DESC so the most specific rule wins: an explicit
--    'docs.google.com' beats a general 'google.com'. Department precedence
--    still comes first.
--
-- 2. UNMATCHED ACTIVITY IS UNPRODUCTIVE, NOT UNCOUNTED.
--    0118 made unmatched time NULL so it dropped out of the ratio. That was the
--    right fix for its problem (everyone scoring 50%%) but it left a real hole:
--    an employee could spend the entire day in applications nobody had
--    catalogued and still score 100%%, because the ratio only considered the
--    sliver of time that happened to match a rule.
--
--    The policy is now explicit — if it is not in the catalogue, it does not
--    count as work. 'neutral' remains the escape hatch and is still excluded
--    from the ratio entirely, which is what protects OS shell processes,
--    browsers, search engines and webmail from being scored against the
--    employee (see 0133).
--
-- ORDER OF DEPLOYMENT MATTERS. 0133 must be applied first. Applying this
-- migration against an organisation with an empty ruleset would score every
-- single second as unproductive.

-- org_productivity_daily
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
      -- Split into kind + subject rather than one glued 'app:x' / 'host:y'
      -- string. Host rules now match on suffix as well as equality, which needs
      -- the bare hostname.
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
      -- The acting agent's department, so the rule lookup below can prefer a
      -- department-specific classification over the org-wide one.
      (SELECT oa.department FROM org_agents oa WHERE oa.id = al.agent_id) AS dept
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.created_at >= (SELECT first_day FROM bounds)
      AND al.created_at <  (SELECT last_day FROM bounds) + interval '1 day'
  ),
  categorized AS (
    SELECT r.day, r.agent_id, r.activity_type, r.duration, coalesce(pr.category, 'unproductive') AS category
    FROM rows r
    LEFT JOIN LATERAL (
      SELECT pr.category
      FROM public.productivity_rules pr
      WHERE pr.org_id = p_org_id
        -- A rule with NULL department is the org-wide fallback and applies to
        -- everyone; a rule naming a department applies only to that department.
        AND (pr.department IS NULL OR pr.department = r.dept)
        AND pr.match_type = r.kind
        AND (
          lower(pr.pattern) = r.subject
          -- HOSTS ALSO MATCH BY SUFFIX. Matching was exact, which made a
          -- domain rule almost useless in practice: 'github.com' did not match
          -- 'gist.github.com', and real traffic is full of subdomains —
          -- 'console.firebase.google.com', 'eu-north-1.console.aws.amazon.com'.
          -- Cataloguing every subdomain of every vendor is not feasible, so one
          -- rule per registrable domain now covers its subdomains.
          --
          -- The leading '.' is what keeps this safe: '%.github.com' matches
          -- 'gist.github.com' but NOT 'notgithub.com'.
          OR (r.kind = 'host' AND r.subject LIKE '%.' || lower(pr.pattern))
        )
      -- Department beats org-wide; then the MOST SPECIFIC pattern wins, so an
      -- explicit 'docs.google.com' rule outranks a 'google.com' one rather than
      -- the two racing arbitrarily.
      ORDER BY (pr.department IS NULL), length(pr.pattern) DESC
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

-- org_productivity_per_agent
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
      -- Split into kind + subject rather than one glued 'app:x' / 'host:y'
      -- string. Host rules now match on suffix as well as equality, which needs
      -- the bare hostname.
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
      -- Anything with no matching rule counts as UNPRODUCTIVE. Previously it
      -- was NULL and dropped out of the ratio entirely, which meant an
      -- employee could spend all day in unlisted applications and score 100%
      -- on the sliver of time that happened to be catalogued.
      coalesce(pr.category, 'unproductive') AS category
    FROM rows r
    LEFT JOIN LATERAL (
      SELECT pr.category
      FROM public.productivity_rules pr
      WHERE pr.org_id = p_org_id
        -- A rule with NULL department is the org-wide fallback and applies to
        -- everyone; a rule naming a department applies only to that department.
        AND (pr.department IS NULL OR pr.department = r.dept)
        AND pr.match_type = r.kind
        AND (
          lower(pr.pattern) = r.subject
          -- HOSTS ALSO MATCH BY SUFFIX. Matching was exact, which made a
          -- domain rule almost useless in practice: 'github.com' did not match
          -- 'gist.github.com', and real traffic is full of subdomains —
          -- 'console.firebase.google.com', 'eu-north-1.console.aws.amazon.com'.
          -- Cataloguing every subdomain of every vendor is not feasible, so one
          -- rule per registrable domain now covers its subdomains.
          --
          -- The leading '.' is what keeps this safe: '%.github.com' matches
          -- 'gist.github.com' but NOT 'notgithub.com'.
          OR (r.kind = 'host' AND r.subject LIKE '%.' || lower(pr.pattern))
        )
      -- Department beats org-wide; then the MOST SPECIFIC pattern wins, so an
      -- explicit 'docs.google.com' rule outranks a 'google.com' one rather than
      -- the two racing arbitrarily.
      ORDER BY (pr.department IS NULL), length(pr.pattern) DESC
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

-- org_productivity_stats
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
      -- Split into kind + subject rather than one glued 'app:x' / 'host:y'
      -- string. Host rules now match on suffix as well as equality, which needs
      -- the bare hostname.
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
      -- The acting agent's department, so the rule lookup below can prefer a
      -- department-specific classification over the org-wide one.
      (SELECT oa.department FROM org_agents oa WHERE oa.id = al.agent_id) AS dept
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.created_at >= p_since
  ),
  categorized AS (
    SELECT r.activity_type, r.duration, coalesce(pr.category, 'unproductive') AS category
    FROM rows r
    LEFT JOIN LATERAL (
      SELECT pr.category
      FROM public.productivity_rules pr
      WHERE pr.org_id = p_org_id
        -- A rule with NULL department is the org-wide fallback and applies to
        -- everyone; a rule naming a department applies only to that department.
        AND (pr.department IS NULL OR pr.department = r.dept)
        AND pr.match_type = r.kind
        AND (
          lower(pr.pattern) = r.subject
          -- HOSTS ALSO MATCH BY SUFFIX. Matching was exact, which made a
          -- domain rule almost useless in practice: 'github.com' did not match
          -- 'gist.github.com', and real traffic is full of subdomains —
          -- 'console.firebase.google.com', 'eu-north-1.console.aws.amazon.com'.
          -- Cataloguing every subdomain of every vendor is not feasible, so one
          -- rule per registrable domain now covers its subdomains.
          --
          -- The leading '.' is what keeps this safe: '%.github.com' matches
          -- 'gist.github.com' but NOT 'notgithub.com'.
          OR (r.kind = 'host' AND r.subject LIKE '%.' || lower(pr.pattern))
        )
      -- Department beats org-wide; then the MOST SPECIFIC pattern wins, so an
      -- explicit 'docs.google.com' rule outranks a 'google.com' one rather than
      -- the two racing arbitrarily.
      ORDER BY (pr.department IS NULL), length(pr.pattern) DESC
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
