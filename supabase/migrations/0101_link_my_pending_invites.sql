-- 0101_link_my_pending_invites.sql
--
-- RPC the frontend calls from /post-login to bind a freshly-authenticated
-- user to any pending org_members invites that match their email. Belt-and-
-- braces alongside the link_pending_org_member trigger — if the trigger
-- silently failed (race, edge-runtime quirk, OAuth INSERT ordering), the
-- frontend's call here recovers the customer without a manual fix.

BEGIN;

CREATE OR REPLACE FUNCTION public.link_my_pending_invites()
RETURNS int  -- number of rows linked
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
DECLARE
  v_uid     uuid;
  v_email   text;
  v_count   int := 0;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN 0;
  END IF;

  SELECT lower(email) INTO v_email FROM auth.users WHERE id = v_uid;
  IF v_email IS NULL THEN RETURN 0; END IF;

  WITH upd AS (
    UPDATE public.org_members
       SET user_id = v_uid
     WHERE lower(email) = v_email
       AND user_id IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upd;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.link_my_pending_invites() TO authenticated;

COMMIT;
