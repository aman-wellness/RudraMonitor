-- 0056_offboarding_stage_split.sql
-- Split the offboarding flow so credentials revocation and device handover
-- are two distinct stages. Previously the access_revoked stage's "Complete"
-- button did everything in one shot — IT could not pause between "I've
-- revoked all app passwords" and "the laptop is back in my hand".
--
-- New flow:
--   Stage 1 creds_review     → IT verified the creds list (email already sent)
--   Stage 2 access_revoked   → M365/Google sign-in revoked + every credential
--                              marked revoked one-by-one (no auto-complete)
--   Stage 3 devices_pending  → NEW — device handover + IT remark
--   Stage 4 completed        → NOC issued + HR/Accounts emailed
--
-- We're keeping the existing column name `current_stage` but expand the
-- check constraint to allow the new value `devices_pending`.

alter table public.offboardings
  drop constraint if exists offboardings_current_stage_check;

alter table public.offboardings
  add constraint offboardings_current_stage_check
  check (current_stage in ('creds_review','access_revoked','devices_pending','completed'));
