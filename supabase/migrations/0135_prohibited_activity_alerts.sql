-- Prohibited apps and websites, and an alert when one is accessed.
--
-- The Alerts page only ever showed alerts the AGENT raised — high CPU, high
-- memory, low disk, extended idle, offline. Nothing watched what an employee
-- actually opened, so visiting an adult or piracy site produced no alert at
-- all; at most it counted as unproductive time, indistinguishable from an hour
-- in an uncatalogued text editor.
--
-- WHY A FOURTH CATEGORY RATHER THAN REUSING 'unproductive'. Since 0134 anything
-- not in the catalogue is already unproductive, so 'unproductive' can no longer
-- distinguish "a tool we have not classified" from "a site that breaches the
-- acceptable-use policy". Those need different responses: one is a scoring
-- detail, the other is something a manager should be told about. 'prohibited'
-- carries that distinction, and scores as unproductive so no productivity
-- number changes meaning.
--
-- WHY A TRIGGER RATHER THAN AGENT-SIDE DETECTION. Detecting this on the
-- endpoint would mean pushing a blocklist to every agent and shipping an agent
-- release to change it. Evaluating it where the activity lands means the list is
-- editable in Admin Portal → Applications and takes effect on the next sample,
-- with no rollout — and it also covers activity arriving by any other path.

-- 1. Allow the new category ---------------------------------------------------
ALTER TABLE public.productivity_rules
  DROP CONSTRAINT IF EXISTS productivity_rules_category_check;
ALTER TABLE public.productivity_rules
  ADD CONSTRAINT productivity_rules_category_check
  CHECK (category = ANY (ARRAY['productive', 'unproductive', 'neutral', 'prohibited']));

COMMENT ON COLUMN public.productivity_rules.category IS
  'productive / unproductive / neutral / prohibited. neutral is excluded from '
  'the productivity ratio entirely. prohibited scores the same as unproductive '
  'AND raises an alert when the app or site is accessed.';

-- 2. Seed the prohibited list -------------------------------------------------
-- Extends the catalogue seeded by 0133. Same contract: idempotent, and
-- ON CONFLICT DO NOTHING so an admin who has already reclassified something
-- keeps their decision.
CREATE OR REPLACE FUNCTION public.seed_prohibited_rules(p_org_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_inserted integer;
BEGIN
  WITH blocklist(match_type, pattern) AS (
    VALUES
    ('host', 'pornhub.com'),
    ('host', 'xvideos.com'),
    ('host', 'xnxx.com'),
    ('host', 'xhamster.com'),
    ('host', 'redtube.com'),
    ('host', 'youporn.com'),
    ('host', 'spankbang.com'),
    ('host', 'onlyfans.com'),
    ('host', 'stripchat.com'),
    ('host', 'chaturbate.com'),
    ('host', 'bongacams.com'),
    ('host', 'livejasmin.com'),
    ('host', 'cam4.com'),
    ('host', 'myfreecams.com'),
    ('host', 'brazzers.com'),
    ('host', 'nutaku.net'),
    ('host', 'rule34.xxx'),
    ('host', 'e-hentai.org'),
    ('host', 'nhentai.net'),
    ('host', 'hanime.tv'),
    ('host', 'motherless.com'),
    ('host', 'literotica.com'),
    ('host', 'adultfriendfinder.com'),
    ('host', 'ashleymadison.com'),
    ('host', 'fetlife.com'),
    ('host', 'eporner.com'),
    ('host', 'txxx.com'),
    ('host', 'hqporner.com'),
    ('host', 'porntrex.com'),
    ('host', 'thumbzilla.com'),
    ('host', 'tnaflix.com'),
    ('host', 'porn.com'),
    ('host', 'sex.com'),
    ('host', 'xhamsterlive.com'),
    ('host', 'bet365.com'),
    ('host', 'williamhill.com'),
    ('host', 'betway.com'),
    ('host', 'unibet.com'),
    ('host', 'bwin.com'),
    ('host', '888casino.com'),
    ('host', 'pokerstars.com'),
    ('host', 'partypoker.com'),
    ('host', 'ladbrokes.com'),
    ('host', 'paddypower.com'),
    ('host', 'betfair.com'),
    ('host', 'draftkings.com'),
    ('host', 'fanduel.com'),
    ('host', 'stake.com'),
    ('host', 'roobet.com'),
    ('host', 'bovada.lv'),
    ('host', 'dream11.com'),
    ('host', 'my11circle.com'),
    ('host', 'rummycircle.com'),
    ('host', 'junglee.com'),
    ('host', 'parimatch.com'),
    ('host', '1xbet.com'),
    ('host', 'melbet.com'),
    ('host', 'casumo.com'),
    ('host', 'leovegas.com'),
    ('host', 'jackpotcity.com'),
    ('host', 'thepiratebay.org'),
    ('host', '1337x.to'),
    ('host', 'rarbg.to'),
    ('host', 'yts.mx'),
    ('host', 'torrentgalaxy.to'),
    ('host', 'nyaa.si'),
    ('host', 'kickasstorrents.to'),
    ('host', 'limetorrents.lol'),
    ('host', 'torlock.com'),
    ('host', 'zooqle.com'),
    ('host', 'eztv.re'),
    ('host', 'fitgirl-repacks.site'),
    ('host', 'skidrowreloaded.com'),
    ('host', 'igg-games.com'),
    ('host', 'steamunlocked.net'),
    ('host', 'ocean-of-games.com'),
    ('host', 'libgen.is'),
    ('host', 'sci-hub.se'),
    ('host', 'z-lib.io'),
    ('host', 'annas-archive.org'),
    ('host', '123movies.net'),
    ('host', 'fmovies.to'),
    ('host', 'putlocker.vip'),
    ('host', 'soap2day.to'),
    ('host', 'lookmovie.to'),
    ('host', 'sflix.to'),
    ('host', 'primewire.mx'),
    ('host', 'cataz.to'),
    ('host', 'gomovies.sx'),
    ('host', 'crackstreams.to'),
    ('host', 'streameast.to'),
    ('host', 'vipleague.im'),
    ('host', 'hidemyass.com'),
    ('host', 'proxysite.com'),
    ('host', 'kproxy.com'),
    ('host', 'croxyproxy.com'),
    ('host', 'hide.me'),
    ('host', 'ultrasurf.us'),
    ('host', 'psiphon.ca'),
    ('host', 'torproject.org'),
    ('host', 'nulled.to'),
    ('host', 'cracked.io'),
    ('host', 'raidforums.com'),
    ('host', 'breachforums.st'),
    ('host', 'leakbase.io'),
    ('host', 'combolist.net'),
    ('host', 'stresser.net'),
    ('host', 'darkweblink.com')
  ),
  ins AS (
    INSERT INTO public.productivity_rules (org_id, match_type, pattern, category, department)
    SELECT p_org_id, b.match_type, b.pattern, 'prohibited', NULL
    FROM blocklist b
    ON CONFLICT (org_id, match_type, pattern, department) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;
  RETURN v_inserted;
END
$fn$;

COMMENT ON FUNCTION public.seed_prohibited_rules(uuid) IS
  'Seeds a starter acceptable-use blocklist (adult, gambling, piracy, '
  'anonymity/credential-dump services) as prohibited rules. Deliberately a '
  'starter list of well-known domains, not an attempt at completeness — '
  'exhaustive category feeds are a commercial product and go stale weekly.';

DO $do$
DECLARE r record; n integer; total integer := 0;
BEGIN
  FOR r IN SELECT id FROM public.organizations LOOP
    SELECT public.seed_prohibited_rules(r.id) INTO n;
    total := total + n;
  END LOOP;
  RAISE NOTICE 'seeded % prohibited rules across all organisations', total;
END $do$;

-- Fold it into new-org seeding too, so a new customer gets both catalogues.
CREATE OR REPLACE FUNCTION public.tg_seed_org_productivity_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $tg$
BEGIN
  PERFORM public.seed_default_productivity_rules(NEW.id);
  PERFORM public.seed_prohibited_rules(NEW.id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'could not seed default productivity rules for org %: %', NEW.id, SQLERRM;
  RETURN NULL;
END
$tg$;

-- 3. Raise an alert when prohibited activity lands ----------------------------
CREATE OR REPLACE FUNCTION public.tg_alert_on_prohibited_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $tg$
DECLARE
  v_org      uuid;
  v_dept     text;
  v_kind     text;
  v_subject  text;
  v_pattern  text;
  v_type     text;
  v_label    text;
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

  -- Same resolution the productivity RPCs use: department override first, then
  -- the org-wide rule, most specific pattern first, hosts matching by suffix.
  -- Reusing it means a rule an admin can see in the Applications tab is exactly
  -- the rule that decides whether an alert fires.
  SELECT pr.pattern INTO v_pattern
  FROM public.productivity_rules pr
  WHERE pr.org_id = v_org
    AND pr.match_type = v_kind
    AND (pr.department IS NULL OR pr.department = v_dept)
    AND (
      lower(pr.pattern) = v_subject
      OR (v_kind = 'host' AND v_subject LIKE '%.' || lower(pr.pattern))
    )
  ORDER BY (pr.department IS NULL), length(pr.pattern) DESC
  LIMIT 1;

  -- Only the winning rule counts. Checking "is there ANY prohibited rule that
  -- matches" would fire even when a more specific rule had reclassified the
  -- site as allowed, which is the whole point of the precedence order.
  IF v_pattern IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.productivity_rules pr
    WHERE pr.org_id = v_org AND pr.match_type = v_kind
      AND lower(pr.pattern) = lower(v_pattern)
      AND (pr.department IS NULL OR pr.department = v_dept)
      AND pr.category = 'prohibited'
    ORDER BY (pr.department IS NULL) LIMIT 1
  ) THEN
    RETURN NULL;
  END IF;

  -- Cooldown. The agent re-reports the foreground window every few seconds, so
  -- without this a single visit would generate an alert per sample and bury
  -- everything else on the page. One alert per agent + subject per hour.
  IF EXISTS (
    SELECT 1 FROM public.alerts al
    WHERE al.agent_id = NEW.agent_id
      AND al.alert_type = v_type
      AND al.message = v_label || ': ' || v_pattern
      AND al.created_at > now() - interval '1 hour'
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.alerts (agent_id, alert_type, message)
  VALUES (NEW.agent_id, v_type, v_label || ': ' || v_pattern);

  RETURN NULL;
END
$tg$;

COMMENT ON FUNCTION public.tg_alert_on_prohibited_activity() IS
  'Raises a prohibited_site / prohibited_app alert when activity matches a '
  'prohibited rule. Message is deterministic per matched pattern so the '
  'one-hour cooldown can dedupe it; the specific page is visible in the '
  'agent''s Browser tab.';

DROP TRIGGER IF EXISTS trg_alert_on_prohibited_activity ON public.activity_logs;
CREATE TRIGGER trg_alert_on_prohibited_activity
  AFTER INSERT ON public.activity_logs
  FOR EACH ROW
  -- Filtered in WHEN so the function body is never entered for screenshot,
  -- video, idle or session rows, which are the bulk of the table.
  WHEN (NEW.activity_type IN ('browser', 'app'))
  EXECUTE FUNCTION public.tg_alert_on_prohibited_activity();

-- Supports the cooldown lookup above; without it every prohibited sample would
-- scan the alert history for that agent.
CREATE INDEX IF NOT EXISTS alerts_agent_type_time_idx
  ON public.alerts (agent_id, alert_type, created_at DESC);

NOTIFY pgrst, 'reload schema';
