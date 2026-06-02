-- 0104_find_auth_user_by_email.sql
--
-- Helper RPC for edge functions that need to look up an auth.users row by
-- email. PostgREST doesn't expose the `auth` schema directly, so a
-- SECURITY DEFINER wrapper is the cleanest path. Service-role-only via
-- explicit GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.find_auth_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM auth.users
   WHERE lower(email) = lower(p_email)
   LIMIT 1;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_auth_user_id_by_email(text) TO service_role;

COMMIT;
