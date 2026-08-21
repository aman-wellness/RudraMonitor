-- Substring matching for hosts, and one shared resolver for every consumer.
--
-- THE PROBLEM. Piracy and adult sites rotate the REGISTRABLE DOMAIN, not just
-- the subdomain. A single afternoon of real traffic produced:
--
--   vegamovie.pe   vegamovie.se   vegamoviess.pro   vega-med.com
--   hdhub4u.bi     new1.hdhub4u.af
--   moviesflixworld.in            themoviesflix.care
--
-- Those are three brands across nine hostnames, with the TLD itself changing.
-- Neither exact matching nor the suffix matching added in 0134 can follow that:
-- a rule for `vegamovies.com` matches none of the four Vegamovies domains, and
-- `hdhub4u.bi` and `hdhub4u.af` share no suffix. An admin blocking one of these
-- would watch the same site reappear under a new name within days.
--
-- So `match_type` gains 'host_contains': the pattern matches anywhere in the
-- hostname. One rule for `vegamovie` covers all four; `hdhub4u` covers both
-- TLDs; `moviesflix` covers both spellings.
--
-- SPECIFICITY ORDER, so a broad rule cannot swallow a deliberate exception:
--   1. department-scoped before organisation-wide  (unchanged)
--   2. exact host      — 'docs.google.com'
--   3. domain suffix   — 'google.com' matching 'docs.google.com'
--   4. contains        — 'moviesflix' matching 'themoviesflix.care'
--   5. longer pattern before shorter
-- An exact rule therefore always beats a substring rule, which is what lets a
-- team whitelist one site inside an otherwise-blocked brand.
--
-- SINGLE SOURCE OF TRUTH. The matching expression had been copy-pasted into
-- three productivity RPCs and the prohibited-activity trigger. Four copies of a
-- precedence rule is four chances for the number on the dashboard to disagree
-- with the number in a report, so it now lives in one function that all of them
-- call. Declared STABLE and written in SQL so Postgres can inline it rather
-- than paying a call per activity row.

ALTER TABLE public.productivity_rules
  DROP CONSTRAINT IF EXISTS productivity_rules_match_type_check;
ALTER TABLE public.productivity_rules
  ADD CONSTRAINT productivity_rules_match_type_check
  CHECK (match_type = ANY (ARRAY['app', 'host', 'host_contains']));

COMMENT ON COLUMN public.productivity_rules.match_type IS
  'app           — exact process name, case-insensitive. '
  'host          — exact hostname OR any subdomain of it. '
  'host_contains — pattern appears anywhere in the hostname; for sites that '
  'rotate domains. More specific match types outrank less specific ones.';

CREATE OR REPLACE FUNCTION public.resolve_rule_category(
  p_org_id  uuid,
  p_dept    text,
  p_kind    text,     -- 'app' or 'host'; describes the ACTIVITY, not the rule
  p_subject text      -- lower-cased process name or hostname
)
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  SELECT pr.category
  FROM public.productivity_rules pr
  WHERE pr.org_id = p_org_id
    -- A rule with NULL department is the org-wide fallback and applies to
    -- everyone; a rule naming a department applies only to that department.
    AND (pr.department IS NULL OR pr.department = p_dept)
    AND (
      -- Applications match exactly. A process name has no hierarchy to walk and
      -- substring matching there would be dangerous: 'chrome' would also catch
      -- an unrelated 'chromedriver'.
      (p_kind = 'app'  AND pr.match_type = 'app'  AND lower(pr.pattern) = p_subject)
      -- Exact hostname.
      OR (p_kind = 'host' AND pr.match_type = 'host' AND lower(pr.pattern) = p_subject)
      -- Any subdomain of the pattern. The leading dot is what keeps this safe:
      -- '%.github.com' matches 'gist.github.com' but NOT 'notgithub.com'.
      OR (p_kind = 'host' AND pr.match_type = 'host'
          AND p_subject LIKE '%.' || lower(pr.pattern))
      -- Substring anywhere in the hostname.
      OR (p_kind = 'host' AND pr.match_type = 'host_contains'
          AND p_subject LIKE '%' || lower(pr.pattern) || '%')
    )
  ORDER BY
    (pr.department IS NULL),                       -- department first
    CASE                                           -- then most specific match
      WHEN pr.match_type = 'app' THEN 0
      WHEN pr.match_type = 'host' AND lower(pr.pattern) = p_subject THEN 0
      WHEN pr.match_type = 'host' THEN 1
      ELSE 2
    END,
    length(pr.pattern) DESC                        -- then longest pattern
  LIMIT 1;
$fn$;

COMMENT ON FUNCTION public.resolve_rule_category(uuid, text, text, text) IS
  'The winning productivity category for one activity subject, or NULL when no '
  'rule matches (callers treat NULL as unproductive — see 0134). The single '
  'implementation of rule precedence: department, then match specificity, then '
  'pattern length.';

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
      -- Delegates to the single resolver so the RPCs, the prohibited-activity
      -- trigger and the dashboard can never disagree about which rule wins.
      -- This logic used to be copy-pasted into each of them.
      SELECT public.resolve_rule_category(p_org_id, r.dept, r.kind, r.subject) AS category
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
      -- Delegates to the single resolver so the RPCs, the prohibited-activity
      -- trigger and the dashboard can never disagree about which rule wins.
      -- This logic used to be copy-pasted into each of them.
      SELECT public.resolve_rule_category(p_org_id, r.dept, r.kind, r.subject) AS category
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
      -- Delegates to the single resolver so the RPCs, the prohibited-activity
      -- trigger and the dashboard can never disagree about which rule wins.
      -- This logic used to be copy-pasted into each of them.
      SELECT public.resolve_rule_category(p_org_id, r.dept, r.kind, r.subject) AS category
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

-- Re-point the prohibited-activity trigger at the shared resolver. It carried
-- its own copy of the matching rules, so a host_contains rule would have raised
-- no alert even while the productivity figures counted it.
CREATE OR REPLACE FUNCTION public.tg_alert_on_prohibited_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $tg$
DECLARE
  v_org     uuid;
  v_dept    text;
  v_kind    text;
  v_subject text;
  v_cat     text;
  v_type    text;
  v_label   text;
BEGIN
  IF NEW.activity_type = 'browser' THEN
    v_kind := 'host';
    v_subject := lower(coalesce(
      (regexp_match(coalesce(NEW.url, ''),
        '(?:https?://)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)', 'i'))[1], ''));
    v_type := 'prohibited_site';
    v_label := 'Prohibited website accessed';
  ELSIF NEW.activity_type = 'app' THEN
    v_kind := 'app';
    v_subject := lower(coalesce(NEW.application_name, ''));
    v_type := 'prohibited_app';
    v_label := 'Prohibited application used';
  ELSE
    RETURN NULL;
  END IF;

  IF v_subject = '' THEN RETURN NULL; END IF;

  SELECT a.org_id, a.department INTO v_org, v_dept
  FROM public.agents a WHERE a.id = NEW.agent_id;
  IF v_org IS NULL THEN RETURN NULL; END IF;

  v_cat := public.resolve_rule_category(v_org, v_dept, v_kind, v_subject);
  IF v_cat IS DISTINCT FROM 'prohibited' THEN RETURN NULL; END IF;

  -- Cooldown keyed on the SUBJECT, not the matched pattern. With a rotating
  -- brand, one `host_contains` rule covers many hostnames, and each of those is
  -- a separate visit worth reporting — keying on the pattern would report the
  -- first domain and silence every other one for an hour.
  IF EXISTS (
    SELECT 1 FROM public.alerts al
    WHERE al.agent_id = NEW.agent_id
      AND al.alert_type = v_type
      AND al.message = v_label || ': ' || v_subject
      AND al.created_at > now() - interval '1 hour'
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.alerts (agent_id, alert_type, message)
  VALUES (NEW.agent_id, v_type, v_label || ': ' || v_subject);

  RETURN NULL;
END
$tg$;

-- Starter substring rules for the brands seen rotating domains in real traffic.
-- Kept short and unambiguous: each token is meaningless outside these brands, so
-- it cannot catch a legitimate site by accident.
CREATE OR REPLACE FUNCTION public.seed_rotating_domain_rules(p_org_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_inserted integer;
BEGIN
  WITH brands(pattern) AS (
    VALUES
    -- 'vegamovie' already covers 'vegamovies*' as a substring; both are listed
    -- so the brand is findable by either spelling when an admin searches.
    ('vegamovie'), ('vegamovies'), ('hdhub4u'), ('hdstream4u'), ('moviesflix'),
    ('uploadflix'),
    ('filmyzilla'), ('katmovie'), ('9xmovie'), ('bolly4u'), ('mkvcinemas'),
    ('extramovies'), ('worldfree4u'), ('movierulz'), ('tamilrocker'),
    ('ibomma'), ('sdmovies'), ('cinevood'), ('skymovies'), ('pagalmovies'),
    ('okhatrimaza'), ('downloadhub'), ('7starhd'), ('coolmoviez'),
    ('fmovies'), ('soap2day'), ('putlocker'), ('123movies'), ('yesmovies'),
    ('primewire'), ('lookmovie'), ('gomovies'), ('einthusan'),
    ('crackstream'), ('streameast'), ('vipleague'), ('sportsurge'),
    ('thepiratebay'), ('1337x'), ('rarbg'), ('torrentgalaxy'), ('limetorrent'),
    ('pornhub'), ('xvideos'), ('xhamster'), ('xnxx'), ('redtube'),
    ('spankbang'), ('stripchat'), ('chaturbate'), ('bongacams'), ('hanime'),
    ('nhentai'), ('hentai'), ('camsoda'), ('brazzers')
  ),
  ins AS (
    INSERT INTO public.productivity_rules (org_id, match_type, pattern, category, department)
    SELECT p_org_id, 'host_contains', b.pattern, 'prohibited', NULL
    FROM brands b
    ON CONFLICT (org_id, match_type, pattern, department) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END
$fn$;

COMMENT ON FUNCTION public.seed_rotating_domain_rules(uuid) IS
  'Seeds host_contains rules for site families known to rotate domains, where a '
  'per-domain blocklist goes stale within days. Idempotent and non-destructive.';

DO $do$
DECLARE r record; n integer; total integer := 0;
BEGIN
  FOR r IN SELECT id FROM public.organizations LOOP
    SELECT public.seed_rotating_domain_rules(r.id) INTO n;
    total := total + n;
  END LOOP;
  RAISE NOTICE 'seeded % rotating-domain rules across all organisations', total;
END $do$;

-- New organisations get this catalogue too.
CREATE OR REPLACE FUNCTION public.tg_seed_org_productivity_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $tg$
BEGIN
  PERFORM public.seed_default_productivity_rules(NEW.id);
  PERFORM public.seed_prohibited_rules(NEW.id);
  PERFORM public.seed_rotating_domain_rules(NEW.id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'could not seed default productivity rules for org %: %', NEW.id, SQLERRM;
  RETURN NULL;
END
$tg$;

NOTIFY pgrst, 'reload schema';
