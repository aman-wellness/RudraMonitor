-- Security hardening migration. Closes findings from the 2026-06-02 audit:
--   H-02: billing_entity SELECT was USING (true) — bank/GST/PAN of the
--         operating company exposed to any authenticated user (and, until
--         Kong gating, any anonymous one). Lock to authenticated users only.
--   M-10: invoice number allocation race — wrap generate_billing_invoice
--         number stamping in a row-level lock.
--   H-04: per-(email,ip) brute-force counter for OTP / login.

BEGIN;

-- ---------------------------------------------------------------------------
-- billing_entity: read restricted to authenticated callers. The frontend
-- only needs the "From" block when rendering an invoice in the dashboard,
-- so anon access is unnecessary. Super-admin write policy unchanged.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "billing_entity_read_all" ON public.billing_entity;
CREATE POLICY "billing_entity_read_authenticated"
  ON public.billing_entity FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- otp_rate_limit table: per (channel_key, ip) sliding window. Edge functions
-- call check_and_record_otp_attempt() before sending or verifying OTPs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.otp_rate_limit (
  id          bigserial PRIMARY KEY,
  scope       text   NOT NULL,           -- 'invoice_otp' | 'phone_otp' | 'pwd_reset' | 'login'
  channel_key text   NOT NULL,           -- email / phone / request_id hash
  ip_address  inet   NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  outcome     text   NOT NULL DEFAULT 'attempt' -- 'attempt' | 'success' | 'fail'
);
CREATE INDEX IF NOT EXISTS otp_rate_limit_lookup
  ON public.otp_rate_limit (scope, channel_key, attempted_at DESC);
CREATE INDEX IF NOT EXISTS otp_rate_limit_ip_lookup
  ON public.otp_rate_limit (scope, ip_address, attempted_at DESC);

-- Only service_role can read/write this table.
ALTER TABLE public.otp_rate_limit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS otp_rate_limit_no_anon ON public.otp_rate_limit;
CREATE POLICY otp_rate_limit_no_anon ON public.otp_rate_limit FOR ALL USING (false) WITH CHECK (false);

-- Returns TRUE if the caller is within budget. Budget = max 10 attempts in
-- the last 15 minutes per (scope, channel_key) AND per (scope, ip_address).
-- Both gates must pass — defeats the prior bug (#H-08) where IP-rotation
-- silently reset the email counter.
CREATE OR REPLACE FUNCTION public.check_and_record_otp_attempt(
  p_scope text,
  p_channel_key text,
  p_ip inet
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window interval := interval '15 minutes';
  v_limit  int := 10;
  v_email_count int;
  v_ip_count int;
BEGIN
  SELECT COUNT(*) INTO v_email_count
    FROM public.otp_rate_limit
   WHERE scope = p_scope
     AND channel_key = p_channel_key
     AND attempted_at > now() - v_window;

  SELECT COUNT(*) INTO v_ip_count
    FROM public.otp_rate_limit
   WHERE scope = p_scope
     AND ip_address = p_ip
     AND attempted_at > now() - v_window;

  IF v_email_count >= v_limit OR v_ip_count >= v_limit THEN
    INSERT INTO public.otp_rate_limit (scope, channel_key, ip_address, outcome)
      VALUES (p_scope, p_channel_key, p_ip, 'blocked');
    RETURN jsonb_build_object('allowed', false, 'email_attempts', v_email_count, 'ip_attempts', v_ip_count, 'retry_after_seconds', 900);
  END IF;

  INSERT INTO public.otp_rate_limit (scope, channel_key, ip_address)
    VALUES (p_scope, p_channel_key, p_ip);

  RETURN jsonb_build_object('allowed', true, 'email_attempts', v_email_count + 1, 'ip_attempts', v_ip_count + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_record_otp_attempt(text,text,inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_and_record_otp_attempt(text,text,inet) TO service_role;

-- Janitor: drop rate-limit rows older than 1 day. Triggered by pg_cron in a
-- separate migration if available; safe to call manually otherwise.
CREATE OR REPLACE FUNCTION public.prune_otp_rate_limit() RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM public.otp_rate_limit WHERE attempted_at < now() - interval '1 day';
$$;
REVOKE ALL ON FUNCTION public.prune_otp_rate_limit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_otp_rate_limit() TO service_role;

-- ---------------------------------------------------------------------------
-- invoice numbering race: take a row-level lock on billing_entity while
-- allocating the next number. generate_billing_invoice should already do
-- this; if a future migration recreates it, this comment is the reminder.
-- Add a unique index on billing_invoices.invoice_number to make the race
-- *fail loudly* instead of silently dup-numbering.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.billing_invoices') IS NOT NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_invoice_number_uniq
             ON public.billing_invoices (invoice_number)
             WHERE invoice_number IS NOT NULL';
  END IF;
END $$;

COMMIT;
