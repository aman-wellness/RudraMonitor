-- Open up the `plans` table for anonymous reads of ACTIVE rows only.
--
-- Before this, plans_read required auth.role() = 'authenticated' — which
-- meant the landing page (anonymous visitors) couldn't pull live pricing
-- and we'd fallen back to hardcoded numbers in PlanGrid.tsx. Now any
-- super-admin edit to a plan row propagates to the landing page + the
-- customer portal subscription page immediately on next reload.
--
-- We do NOT expose inactive rows — those are historical / draft plans
-- super-admins toggle off. plans_super_write still gates all mutations.

BEGIN;

DROP POLICY IF EXISTS plans_read ON public.plans;

CREATE POLICY plans_read_public ON public.plans
  FOR SELECT
  USING (is_active = true);

COMMIT;
