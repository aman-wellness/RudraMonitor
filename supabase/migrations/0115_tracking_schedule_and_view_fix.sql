-- 0115_tracking_schedule_and_view_fix.sql
--
-- Two things:
--   1. Add an org-default tracking schedule + per-agent override. When
--      enabled and the current time is OUTSIDE the configured working
--      hours, the agent pauses ALL capture (screenshots, video, USB
--      block, wallpaper, DLP, activity tracking). System metrics still
--      report so the admin sees the device is alive, just not captured.
--
--   2. Drop+recreate `agents_with_seat` view so the columns added in
--      migration 0114 (removable_disks_blocked, wallpaper_enforced)
--      AND the new ones added below are picked up. PostgreSQL views
--      freeze their column list at creation time — `SELECT a.*` does
--      NOT auto-expand when the underlying table gains columns. The
--      result was a real customer-visible bug today where the dashboard
--      always read `undefined` for the new columns and the form defaulted
--      to `true`, making it look like saves silently reverted.

-- ============== Org-default schedule ==============
-- schedule_json shape (TEXT — easier to evolve than a typed jsonb):
-- {
--   "tz": "Asia/Kolkata",
--   "days": {
--     "mon": [{"start":"09:00","end":"18:00"}],
--     "tue": [{"start":"09:00","end":"18:00"}],
--     ... (no entry for sat/sun = those days have no working hours)
--   }
-- }
-- Empty array for a day key = explicit "off" day. Missing key = same.
-- Multiple ranges per day supported (e.g. lunch break: 09:00-13:00 + 14:00-18:00).
ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS tracking_schedule_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tracking_schedule_json text;

-- ============== Per-agent override ==============
-- If override_enabled = true, the agent uses override_schedule_json
-- instead of the org default. If FALSE, the agent uses the org default
-- (which may itself be disabled, meaning 24/7 tracking).
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS tracking_schedule_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tracking_schedule_json text;

-- ============== Recreate agents_with_seat view ==============
-- Frozen-column-list bug fix. Drop+recreate so the SELECT a.* now
-- includes every column on agents, including columns added in 0114
-- (removable_disks_blocked, wallpaper_enforced) and 0115 above.
DROP VIEW IF EXISTS public.agents_with_seat CASCADE;
CREATE OR REPLACE VIEW public.agents_with_seat AS
  SELECT a.*,
         ROW_NUMBER() OVER (PARTITION BY a.org_id ORDER BY a.created_at ASC, a.id ASC) AS seat_rank,
         (ROW_NUMBER() OVER (PARTITION BY a.org_id ORDER BY a.created_at ASC, a.id ASC)
            > public.org_seat_cap(a.org_id)) AS seat_locked
    FROM public.agents a;
ALTER VIEW public.agents_with_seat SET (security_invoker = true);
GRANT SELECT ON public.agents_with_seat TO authenticated, anon;

-- Add the column-level UPDATE grants the agent-update-settings edge function
-- needs. The edge function uses service-role so RLS doesn't gate it, but
-- the explicit grants make the intent visible and prevent regressions if
-- someone ever swaps the function back to user-scoped writes.
GRANT UPDATE (tracking_schedule_override, tracking_schedule_json)
  ON public.agents TO authenticated;
