-- 0102_fix_invoice_inbound_slug_searchpath.sql
--
-- `organizations_seed_invoice_inbound_slug` is a BEFORE INSERT trigger on
-- organizations. It calls unqualified `gen_random_bytes(8)`, which lives in
-- the `extensions` schema on self-hosted Supabase. The function had no
-- `SET search_path` clause, so it inherited the caller's. When invoked from
-- finalize_pending_signup_v2 (search_path = 'public'), `gen_random_bytes`
-- wasn't visible → "function gen_random_bytes(integer) does not exist" →
-- every paid signup failed at verification.
--
-- Fix: fully-qualify the call AND pin search_path so this function works
-- regardless of who triggers it.

BEGIN;

CREATE OR REPLACE FUNCTION public.organizations_seed_invoice_inbound_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  candidate text;
  tries int := 0;
BEGIN
  IF NEW.invoice_inbound_slug IS NOT NULL THEN
    RETURN NEW;
  END IF;
  LOOP
    tries := tries + 1;
    candidate := substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 8);
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE invoice_inbound_slug = candidate) THEN
      NEW.invoice_inbound_slug := candidate;
      RETURN NEW;
    END IF;
    IF tries > 10 THEN
      RAISE EXCEPTION 'could not generate unique invoice_inbound_slug after 10 tries';
    END IF;
  END LOOP;
END
$function$;

COMMIT;
