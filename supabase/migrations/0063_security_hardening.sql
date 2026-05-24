-- Security hardening pass after the v0.2.32 audit.
--
-- The biggest item: org_members.members_insert was `WITH CHECK (user_id =
-- auth.uid())`, which let ANY authenticated user self-insert into ANY org
-- by crafting `INSERT INTO org_members (org_id, user_id, role) VALUES (...)`
-- from the browser console with their own auth token. The legitimate
-- invite flow goes through the `admin-invite-customer-owner` and
-- `invite-member` edge functions which write with the service role and
-- therefore bypass RLS — so blocking all client-side inserts is safe.
--
-- Same logic applies to a few "agent writes via service_role only" tables
-- that previously relied on the absence of an INSERT policy. We make the
-- denial explicit so a future change can't accidentally introduce a
-- permissive policy without someone reading this file first.

BEGIN;

-- 1. org_members: block client-side inserts entirely. Edge functions use
-- service_role which bypasses RLS; sign-up / invite-accept flows
-- continue working.
DROP POLICY IF EXISTS members_insert ON public.org_members;
CREATE POLICY members_insert_blocked ON public.org_members
  FOR INSERT
  WITH CHECK (false);

-- 2. Tables written exclusively by the agent or edge functions via
-- service_role. Make the deny explicit so a permissive policy can't
-- silently be added later.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'activity_logs',
    'system_metrics',
    'alerts',
    'dlp_events',
    'employee_audit',
    'audit_log',
    'credential_request_events',
    'offboarding_events',
    'webrtc_signaling',
    'remote_sessions'
  ] LOOP
    -- INSERT blocker
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      t || '_insert_blocked', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (false)',
      t || '_insert_blocked', t
    );
    -- UPDATE blocker
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      t || '_update_blocked', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (false) WITH CHECK (false)',
      t || '_update_blocked', t
    );
    -- DELETE blocker
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      t || '_delete_blocked', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (false)',
      t || '_delete_blocked', t
    );
  END LOOP;
END $$;

-- 3. credential_request_events: backfill the missing foreign key on org_id
-- so org deletion cascades cleanly and the column can't drift.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credential_request_events_org_id_fkey'
  ) THEN
    ALTER TABLE public.credential_request_events
      ADD CONSTRAINT credential_request_events_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN others THEN
  -- Skip if there are orphan rows; we'll clean those up in a separate
  -- pass. Logging-only — don't block the migration.
  RAISE NOTICE 'skipped credential_request_events FK: %', SQLERRM;
END $$;

COMMIT;
