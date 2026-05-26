-- The organizations_with_features view (and its sibling org_em_active())
-- marked EM as active for ANY trial org, regardless of which plan they
-- signed up for. That's the legacy "trial unlocks everything" behaviour
-- 0075 was supposed to retire — but this view + RPC predate 0075 and
-- kept doing it, so even after we set trial_plan_code='starter-m' the
-- sidebar still showed Employees/Groups/Credentials/Hardware/etc.
--
-- New rule (must match org_effective_features() from 0075):
--   em_active = TRUE when:
--     • em_subscribed (org paid for the EM add-on), OR
--     • subscription_status='trial' AND trial_full_access=TRUE
--       (super-admin granted full-features trial), OR
--     • subscription_status='trial' AND trial_plan_code IN ('em-m','em-y')
--       (customer chose the EM trial path at signup), OR
--     • subscription_status='trial' AND trial_plan_code IS NULL
--       (legacy pre-0075 org — same back-compat path the RPC uses)

-- CREATE OR REPLACE VIEW can't change the column shape when the underlying
-- table has grown (0075 added trial_plan_code etc., shifting o.*), so we
-- drop + recreate. The view only depends on itself, so it's safe to drop.
DROP VIEW IF EXISTS public.organizations_with_features;
CREATE VIEW public.organizations_with_features AS
  SELECT o.*,
         (
           o.em_subscribed
           OR (
             o.subscription_status = 'trial'
             AND o.trial_ends_at > now()
             AND (
               o.trial_full_access = true
               OR o.trial_plan_code IS NULL
               OR o.trial_plan_code IN ('em-m', 'em-y')
             )
           )
         ) AS em_active
    FROM public.organizations o;

-- Keep the view RLS-respecting like 0051 set it.
ALTER VIEW public.organizations_with_features SET (security_invoker = true);
GRANT SELECT ON public.organizations_with_features TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.org_em_active(p_org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    o.em_subscribed
    OR (
      o.subscription_status = 'trial'
      AND o.trial_ends_at > now()
      AND (
        o.trial_full_access = true
        OR o.trial_plan_code IS NULL
        OR o.trial_plan_code IN ('em-m', 'em-y')
      )
    )
  FROM public.organizations o
  WHERE o.id = p_org
$$;
