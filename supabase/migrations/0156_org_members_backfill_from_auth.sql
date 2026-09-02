-- 0156_org_members_backfill_from_auth.sql
--
-- Backfill org_members.full_name + email from auth.users, and add a trigger
-- so new rows / user metadata changes stay in sync. Symptom the fix
-- addresses: an org_members row created by an admin who invited a user by
-- email, where the invited user later signed in with Google/SSO, ended up
-- with a real user_id linked but the row's own full_name/email columns
-- stayed null — the dashboard "Organization Users" list then rendered
-- "—" for name and email even though the user was actively working.
--
-- Anon-key clients can't read auth.users, so the dashboard can't derive
-- these values at render time. Trigger + backfill copies the data into
-- org_members where the dashboard already looks.

BEGIN;

-- 1. One-off backfill: any org_members row missing name/email but with a
--    matching auth.users id gets populated from there. Both the empty
--    string and the literal em-dash placeholder count as "missing" —
--    dashboards elsewhere in the app have historically written '—' when
--    they couldn't resolve a name, and we don't want that placeholder
--    surviving this pass.
UPDATE public.org_members om
SET
  full_name = COALESCE(
    NULLIF(NULLIF(om.full_name, ''), '—'),
    NULLIF(u.raw_user_meta_data->>'full_name', ''),
    NULLIF(u.raw_user_meta_data->>'name', ''),
    split_part(u.email, '@', 1)
  ),
  email = COALESCE(NULLIF(om.email, ''), u.email)
FROM auth.users u
WHERE u.id = om.user_id
  AND (
    om.full_name IS NULL OR om.full_name = '' OR om.full_name = '—'
    OR om.email IS NULL OR om.email = ''
  );

-- 2. Trigger: on INSERT (invite → sign-in) or when user_id is set/updated,
--    fill blank name/email from auth.users. Doesn't overwrite non-blank
--    values already there (an admin who manually typed a name keeps it).
CREATE OR REPLACE FUNCTION public.org_members_sync_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  au_email text;
  au_name  text;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT
    u.email,
    COALESCE(
      NULLIF(u.raw_user_meta_data->>'full_name', ''),
      NULLIF(u.raw_user_meta_data->>'name', ''),
      split_part(u.email, '@', 1)
    )
  INTO au_email, au_name
  FROM auth.users u
  WHERE u.id = NEW.user_id;

  IF au_email IS NOT NULL AND (NEW.email IS NULL OR NEW.email = '') THEN
    NEW.email := au_email;
  END IF;
  IF au_name IS NOT NULL AND (NEW.full_name IS NULL OR NEW.full_name = '' OR NEW.full_name = '—') THEN
    NEW.full_name := au_name;
  END IF;
  -- Also handle the em-dash placeholder that dashboards elsewhere may
  -- have written into new rows (the "—" fallback in the display mapper
  -- occasionally leaked into inserts). Treat as blank.
  IF NEW.full_name = '—' THEN NEW.full_name := NULL; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS org_members_sync_from_auth_trg ON public.org_members;
CREATE TRIGGER org_members_sync_from_auth_trg
BEFORE INSERT OR UPDATE OF user_id ON public.org_members
FOR EACH ROW EXECUTE FUNCTION public.org_members_sync_from_auth();

COMMIT;
