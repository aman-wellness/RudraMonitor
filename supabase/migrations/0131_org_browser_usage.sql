-- org_browser_usage — server-side aggregation for Live monitoring → Browser.
--
-- Fixes three problems the client-side version had, plus one of my own from an
-- earlier draft of this migration.
--
--   1. LIMIT BEFORE GROUPING. The tab fetched raw activity_logs with
--      `limit: 200` and grouped in the browser. One agent produced 224 browser
--      rows in a day, so the list was truncated before it was aggregated.
--
--   2. THE PAGE TITLE WAS NEVER FETCHED. activity_logs.page_title has existed
--      all along and useActivityLogs did not select it, so the tab rendered
--      `url` in a column it called pageTitle. For a link that looked merely
--      redundant; for a search it was unreadable —
--      google.com/search?q=insidious+all+parts&oq=...&gs_lcrp=EgZjaHJvbWUq...
--      (~300 characters of tracking parameters) rather than the title
--      "insidious all parts - Google Search".
--
--   3. UNATTRIBUTABLE SAMPLES OUTRANKED REAL ONES. Rows whose address bar could
--      not be read have no host and collapsed into one "—" group which, holding
--      the most time, sorted to the top. They are excluded here and counted
--      separately so the caller can disclose them; dropping them silently would
--      overstate how much browsing was accounted for.
--
--   4. GROUPING BY HOST DESTROYED THE HISTORY. This is the one I introduced.
--      Grouping by (agent, host) gives ONE row per site carrying the most recent
--      title, so every Google search shared a single google.com row and each new
--      search overwrote the last: searching "insidious all parts" and later
--      "meow and meow" looked like the row had been edited rather than a second
--      search having happened. Sites people use by navigating — search engines,
--      wikis, ticket trackers — became a single opaque row.
--
--      Grouping is therefore by (agent, host, page title). Measured on real
--      data: 63 samples carried 34 distinct titles against 36 distinct URLs, so
--      the title is nearly as granular as the URL while being immune to the
--      volatile query parameters that would otherwise split one logical page
--      across many rows (imdb.com's ?ref_= differs on every visit).
--
-- The host is still returned and still drives classification, so a `host` rule
-- keeps applying to every page on that domain.

CREATE OR REPLACE FUNCTION public.org_browser_usage(
  p_org_id   uuid,
  p_since    timestamptz,
  p_until    timestamptz DEFAULT now(),
  p_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
  agent_id       uuid,
  agent_name     text,
  department     text,
  host           text,
  page_title     text,
  last_url       text,
  total_seconds  bigint,
  visits         bigint,
  last_visit     timestamptz,
  -- Constant across every row of a call: samples whose address bar could not be
  -- read, and the time they represent. Carried on the rows so disclosing them
  -- costs the caller no extra query.
  unresolved_samples bigint,
  unresolved_seconds bigint
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
  browser_rows AS (
    SELECT
      al.agent_id,
      al.url,
      al.duration,
      al.created_at,
      -- Same expression as org_productivity_*, so a host rule matches the same
      -- string in the table and in the productivity weighting.
      lower(coalesce(
        (regexp_match(coalesce(al.url, ''),
          '(?:https?://)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)',
          'i'))[1],
        ''
      )) AS host,
      -- The stored title is the raw OS window title, which ends in the browser
      -- name on every Chromium/Firefox row ("… - Google Search - Google Chrome").
      -- Trimming it here rather than in the agent also cleans up the samples
      -- already recorded. Only a known set of browser names is stripped, so an
      -- unrelated title ending in " - Something" is left intact.
      nullif(trim(regexp_replace(
        coalesce(al.page_title, ''),
        '\s+[-–—]\s+(Google Chrome|Chromium|Microsoft.{0,2}Edge|Brave|Mozilla Firefox|Firefox|Opera|Vivaldi|Arc|Safari)\s*$',
        ''
      )), '') AS title
    FROM public.activity_logs al
    WHERE al.agent_id IN (SELECT id FROM org_agents)
      AND al.activity_type = 'browser'
      AND al.created_at >= p_since
      AND al.created_at <  p_until
  ),
  unresolved AS (
    SELECT
      count(*)::bigint                   AS samples,
      sum(coalesce(duration, 0))::bigint AS seconds
    FROM browser_rows
    WHERE host = ''
  ),
  grouped AS (
    SELECT
      r.agent_id,
      r.host,
      -- Samples with no title fall back to the host, so a page whose title was
      -- never captured still gets a row instead of a blank one.
      coalesce(r.title, r.host) AS page_title,
      sum(coalesce(r.duration, 0))::bigint AS total_seconds,
      count(*)::bigint                     AS visits,
      max(r.created_at)                    AS last_visit
    FROM browser_rows r
    WHERE r.host <> ''
    GROUP BY r.agent_id, r.host, coalesce(r.title, r.host)
  )
  SELECT
    g.agent_id,
    oa.agent_name,
    oa.department,
    g.host,
    g.page_title,
    latest.url AS last_url,
    g.total_seconds,
    g.visits,
    g.last_visit,
    coalesce((SELECT samples FROM unresolved), 0),
    coalesce((SELECT seconds FROM unresolved), 0)
  FROM grouped g
  JOIN org_agents oa ON oa.id = g.agent_id
  -- Full URL of the most recent visit to THIS page, for the row's hover text.
  LEFT JOIN LATERAL (
    SELECT r2.url
    FROM browser_rows r2
    WHERE r2.agent_id = g.agent_id
      AND r2.host = g.host
      AND coalesce(r2.title, r2.host) = g.page_title
      AND r2.url <> ''
    ORDER BY r2.created_at DESC
    LIMIT 1
  ) latest ON true
  ORDER BY g.total_seconds DESC, g.last_visit DESC;
$$;

COMMENT ON FUNCTION public.org_browser_usage(uuid, timestamptz, timestamptz, uuid) IS
  'Per (agent, host, page title) browsing totals for a window. Grouped by page '
  'rather than by host so navigating a site — searches especially — produces a '
  'row per page instead of one row per domain whose title is overwritten by '
  'whatever was visited last. Aggregates server-side so the limit bounds pages '
  'rather than raw samples, and reports failed address-bar reads separately.';

GRANT EXECUTE ON FUNCTION public.org_browser_usage(uuid, timestamptz, timestamptz, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
