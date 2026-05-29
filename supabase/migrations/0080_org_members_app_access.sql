-- Per-user feature access (granular gating on top of role).
--
-- Today org_members.role is the only gate: owner/admin see everything,
-- viewer/manager see everything-the-org-has-paid-for. Customer asked
-- for per-USER scoping — e.g. give one teammate ONLY the Credentials
-- Vault and nothing else. role is org-level; this is user-level.
--
-- Design: a new text[] `app_access` listing the feature codes this user
-- may see. NULL = "inherit org-default" (= every paid feature, same as
-- today's behaviour, so no migration of existing rows is needed). An
-- explicit empty array = "no apps, login-only" — useful for billing-
-- only / read-only contacts.
--
-- Owners / admins ALWAYS see every feature regardless of this column —
-- enforced in the dashboard so an admin can't accidentally lock
-- themselves out. The column purely scopes role='viewer' / role='manager'
-- / future fine-grained roles.

BEGIN;

-- Codes the dashboard/sidebar already knows about. Keep this list in
-- lock-step with src/pages/dashboard/DashboardLayout.tsx::sidebarLinks
-- and with the route gates in src/router/config.tsx. Adding a new
-- feature: append the code here AND register it in the UI's
-- ACCESS_CODES helper so admins see a checkbox for it.
ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS app_access text[];

COMMENT ON COLUMN public.org_members.app_access IS
  'Per-user feature whitelist. NULL = inherit org default (every paid '
  'feature). Empty array = no feature access (login-only). Owners and '
  'admins always see everything; this column scopes viewers/managers.';

-- RPC the dashboard calls on every page load to know what to show.
-- Service-role definer so it works even when org_members RLS would
-- otherwise hide the row (the user is looking up THEIR OWN row).
CREATE OR REPLACE FUNCTION public.my_app_access()
RETURNS TABLE(role text, app_access text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role::text, app_access
    FROM public.org_members
   WHERE user_id = auth.uid()
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.my_app_access() TO authenticated;

COMMIT;
