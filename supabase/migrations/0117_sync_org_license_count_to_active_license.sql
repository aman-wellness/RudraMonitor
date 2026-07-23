-- Keep `organizations.license_count` and `licenses.seat_count` (of the active
-- row) in sync automatically.
--
-- Motivation: 2026-07-23 customer report. Dashboard showed "25 / 40" for a
-- prod org — 40 in organizations.license_count, but the active license row
-- still held seat_count = 25. Enrolment enforcement reads through
-- public.org_seat_cap() which returns the active license's seat_count first,
-- so seat #26 onwards was blocked with "license limit exceeded" even though
-- the admin had raised the org-level cap to 40.
--
-- The admin UI at /admin/customers/:id already syncs both when saving the
-- profile (see src/pages/admin/customers/detail.tsx). But at least one path
-- had bumped organizations.license_count without touching the license row —
-- likely a direct Supabase Studio edit, or a code path we don't own that
-- pre-dates the sync logic.
--
-- Rather than audit every current + future call site, put the invariant in
-- the DB. Any UPDATE on organizations.license_count now cascades to the
-- single active license row for that org. Idempotent (skips when equal), no-
-- op when there's no active license (fresh trial orgs before their license
-- is issued).

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_active_license_seat_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only interested in real changes to license_count.
  IF NEW.license_count IS NOT DISTINCT FROM OLD.license_count THEN
    RETURN NEW;
  END IF;

  UPDATE public.licenses
     SET seat_count = NEW.license_count
   WHERE organization_id = NEW.id
     AND status = 'active'
     AND seat_count <> NEW.license_count;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_sync_license_seat_count ON public.organizations;
CREATE TRIGGER trg_sync_license_seat_count
AFTER UPDATE OF license_count ON public.organizations
FOR EACH ROW
EXECUTE FUNCTION public.sync_active_license_seat_count();

-- Backfill: reconcile any currently-mismatched rows in one shot so future
-- reads of org_seat_cap match what the dashboard shows. Only touches
-- (organization, active_license) pairs where the numbers disagree.
UPDATE public.licenses l
   SET seat_count = o.license_count
  FROM public.organizations o
 WHERE l.organization_id = o.id
   AND l.status = 'active'
   AND l.seat_count <> o.license_count;

COMMIT;
