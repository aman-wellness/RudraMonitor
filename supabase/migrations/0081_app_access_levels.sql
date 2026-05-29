-- 3-tier per-feature permission on top of 0080's app_access whitelist.
--
-- 0080 answered "can this user see feature X?". Customer's next ask:
-- "within X, can they edit/delete or just view?". We add a jsonb
-- `app_access_levels` mapping feature_code → 'view' | 'edit' | 'full'.
--
-- Semantics:
--   NULL                          → inherit (= 'full' on every feature
--                                   in app_access, same as today's
--                                   behaviour, so existing rows need
--                                   no migration).
--   {"credentials":"view"}        → user can open Credentials Vault but
--                                   can only see entries, no add/edit/
--                                   delete/grant/upload.
--   {"credentials":"edit",
--    "reports":"view"}            → edit credentials, view-only reports.
--
-- Levels (additive):
--   view  → read pages, run searches, export CSV
--   edit  → view + create/update + upload + grant access
--   full  → edit + delete + danger-zone actions
--
-- app_access (text[]) stays the source of truth for "is the feature
-- granted at all" — the keys of app_access_levels MUST be a subset of
-- app_access. Admin Portal UI keeps them in sync; this comment is the
-- contract.
--
-- Owners + admins ignore both columns and always see everything at the
-- 'full' level — enforced in the dashboard so an org admin can't lock
-- themselves out by accident.

BEGIN;

ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS app_access_levels jsonb;

COMMENT ON COLUMN public.org_members.app_access_levels IS
  'Per-feature access level. jsonb {code: "view"|"edit"|"full"}. NULL '
  'inherits "full" on every code in app_access. Owners + admins always '
  'have full access regardless. Keys must be a subset of app_access.';

-- Extend my_app_access() to return the new column. The dashboard hook
-- reads both: app_access for membership, app_access_levels for the
-- per-feature level. Stays SECURITY DEFINER so an authenticated user
-- can look up their own row even when RLS would hide it.
-- Return signature widened (added app_access_levels) — Postgres refuses
-- to change OUT parameters with REPLACE, so drop + recreate.
DROP FUNCTION IF EXISTS public.my_app_access();
CREATE OR REPLACE FUNCTION public.my_app_access()
RETURNS TABLE(role text, app_access text[], app_access_levels jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role::text, app_access, app_access_levels
    FROM public.org_members
   WHERE user_id = auth.uid()
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.my_app_access() TO authenticated;

COMMIT;
