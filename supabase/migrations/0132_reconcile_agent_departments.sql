-- Reconcile agents.department with org_departments, and stop them diverging.
--
-- THE BUG. The agents page lets an admin type a new department name straight
-- into the per-agent dropdown. That path wrote agents.department (free text, no
-- foreign key) and nothing else, so the department existed as far as every
-- agent listing, filter and report was concerned, but Admin Portal →
-- Departments never showed it: that tab reads org_departments, which had no
-- matching row. An admin who created "IT" from the agents page and then went
-- looking for it in Departments found four seeded departments and no IT.
--
-- Two consequences beyond the missing row:
--
--   * org_departments.agent_count stayed 0 for every department, which LOOKS
--     like a broken counter but is not. The trigger trg_agents_dept_count
--     maintains it correctly via refresh_dept_agent_count(org, dept); it simply
--     had nothing to update, because the one department with an agent in it had
--     no row. The counter was right and the row was missing.
--
--   * The delete confirmation in DepartmentsTab warns "N agent(s) currently
--     assigned" from agent_count. For a department created via the agents page
--     that warning could never fire, so removing a department that was actually
--     in use looked risk-free.
--
-- This migration backfills the missing rows. Going forward the dashboard
-- ensures the row when it assigns a department (see useAgents.updateDepartment),
-- so the two stay in step.
--
-- Deliberately NOT adding a foreign key from agents.department to
-- org_departments.name. Doing so would fail on any existing agent whose
-- department is not in the list, and productivity_rules.department (0129)
-- matches the same free-text column. Tightening all three into a real
-- relationship is a larger change than this fix warrants.

-- Backfill: every department an agent actually reports gets a row. Idempotent,
-- and safe to re-run.
INSERT INTO public.org_departments (org_id, name)
SELECT DISTINCT a.org_id, trim(a.department)
FROM public.agents a
WHERE a.department IS NOT NULL
  AND trim(a.department) <> ''
ON CONFLICT (org_id, name) DO NOTHING;

-- The rows above were inserted with agent_count at its default of 0. The
-- trigger only fires on changes to `agents`, so nothing has recomputed them —
-- do it once here for every department in every org.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT org_id, name FROM public.org_departments LOOP
    PERFORM public.refresh_dept_agent_count(r.org_id, r.name);
  END LOOP;
END $$;

COMMENT ON COLUMN public.org_departments.agent_count IS
  'Agents currently assigned to this department, maintained by '
  'trg_agents_dept_count on public.agents. Only ever non-zero when a matching '
  'org_departments row exists — a department that lives only in '
  'agents.department has nothing for the trigger to update.';

NOTIFY pgrst, 'reload schema';
