-- Prohibited time scores as unproductive.
--
-- 0135 added the 'prohibited' category. The scoring in org_productivity_per_agent
-- tested `category = 'unproductive'` exactly, so a prohibited match matched
-- neither the productive nor the unproductive sum and was excluded from the
-- ratio altogether, exactly like 'neutral'. The effect was perverse: time on a
-- blocked site shrank the denominator and therefore INCREASED the reported
-- productivity percentage.
--
-- org_productivity_stats and org_productivity_daily need no change — they only
-- sum 'productive', and prohibited time is correctly absent from that.

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
                       -- 'prohibited' scores exactly like 'unproductive'. Without
                       -- it here the category would match NEITHER sum and drop out
                       -- of the ratio like 'neutral' — so an hour on a blocked site
                       -- would silently RAISE the productivity figure by shrinking
                       -- the denominator, which is the opposite of the intent.
                       AND c.category IN ('unproductive', 'prohibited')
                      THEN c.duration ELSE 0 END), 0)::bigint
  FROM public.agents a
  LEFT JOIN categorized c ON c.agent_id = a.id
  WHERE a.org_id = p_org_id
  GROUP BY a.id;
$function$;

NOTIFY pgrst, 'reload schema';
