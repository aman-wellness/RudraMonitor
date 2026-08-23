-- 0149_email_intercept_default_off.sql
--
-- Safety flip for v0.7.0 rollout.
--
-- Migration 0148 seeded `dlp_settings.email_intercept_public_only` with
-- default = true, on the reasoning that any org that already had Email
-- DLP enabled implicitly wanted the full MITM path. That default is
-- being reversed for the initial v0.7.0 release: turning HTTPS
-- inspection on for a fleet without an admin explicitly opting in is
-- exactly the kind of "the agent update broke customer browsing" risk
-- the deploy-order memory (`feedback_no_cors_change_in_prod`) is meant
-- to prevent.
--
-- After this migration:
--   • Existing rows keep whatever value the admin already set (if any).
--   • New rows land with FALSE. Admin must flip it on in Settings.
--   • Agents skip the MITM proxy entirely until an org opts in.

alter table public.dlp_settings
  alter column email_intercept_public_only set default false;

-- Existing rows: if the admin never touched the field (still at the
-- 0148 default of true), drop it back to false. If they explicitly set
-- it, we shouldn't override — but there's no way to distinguish
-- "explicit true" from "default true" in postgres, so this migration
-- is applied ONCE with the assumption that no admin has yet opted in
-- (0148 shipped in the same v0.7.0 rollout).
update public.dlp_settings
  set email_intercept_public_only = false
  where email_intercept_public_only = true;

notify pgrst, 'reload schema';
