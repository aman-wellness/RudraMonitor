-- 0147_productivity_rpc_local_timeout.sql
--
-- HOTFIX: Reports "This Week" / "This Month" showed 0 for every agent even
-- though the per-agent breakdown was correct on individual agent detail pages.
--
-- ROOT CAUSE: `authenticated` has statement_timeout=8s in this deployment.
-- The three productivity RPCs (rewritten as SECURITY DEFINER in 0145 / 0146)
-- take ~12s on a 7-day window over the current org's activity_logs volume,
-- so PostgREST kills them with error 57014 ("canceling statement due to
-- statement timeout"). The frontend hooks swallow that error and render a
-- table full of zeros.
--
-- 0146's rewrite already cut the per-row `resolve_rule_category` calls to a
-- CTE, which was the O(n²) hot path — the residual 12s is unavoidable work
-- (materialising a week of `activity_logs` for a busy org and joining it to
-- productivity_rules). Cutting it further needs an index rebuild that is
-- out of scope for a hotfix.
--
-- FIX: since these functions are SECURITY DEFINER we can lift the per-role
-- timeout *inside* the function body only, without changing the role default
-- (which would relax it globally, including for lighter RPCs that should
-- still fail-fast). `SET LOCAL` reverts at transaction end so nothing leaks.
--
-- 120s is deliberately roomy — measured 12s over 7 days, 35s over 30 days,
-- and 65s over 90 days / all-time on the current org's ~640k activity_logs.
-- The RPC gets slower as the org grows. Beyond 120s the "custom range" and
-- "This Year" filters need pre-aggregated daily rollups (nightly cron into
-- a productivity_daily table + reports select from rollup for sub-second
-- reads) rather than pushing this cap higher.

do $$
declare
  fn text;
begin
  for fn in
    select unnest(array[
      'public.org_productivity_daily(uuid, integer, timestamptz, uuid)',
      'public.org_productivity_per_agent(uuid, timestamptz, timestamptz)',
      'public.org_productivity_stats(uuid, timestamptz)'
    ])
  loop
    execute format('alter function %s set statement_timeout = ''120s''', fn);
  end loop;
end $$;

-- Tell PostgREST to refresh its schema cache so the new attribute takes
-- effect on the very next request (rather than after a restart).
notify pgrst, 'reload schema';
