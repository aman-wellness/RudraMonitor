-- 0108_add_seats_to_active_license.sql
--
-- RPC the razorpay-add-seats-verify webhook handler calls after a customer
-- pays a prorated charge to add seats to their existing active subscription.
-- Bumps both organizations.license_count AND the active license's
-- seat_count atomically, keeping the two in sync.
--
-- Does NOT touch the Razorpay subscription's quantity — that's the edge
-- function's job (Update Subscription API).

BEGIN;

CREATE OR REPLACE FUNCTION public.add_seats_to_active_license(
  p_org_id uuid,
  p_extra_seats int,
  p_razorpay_payment_id text DEFAULT NULL,
  p_prorated_amount_paise int DEFAULT NULL
)
RETURNS TABLE(new_license_count int, license_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_lic_id uuid;
  v_new_count int;
BEGIN
  IF p_extra_seats <= 0 OR p_extra_seats > 10000 THEN
    RAISE EXCEPTION 'extra_seats out of range: %', p_extra_seats USING ERRCODE = '22023';
  END IF;

  -- Bump the active main-plan license's seat_count.
  UPDATE public.licenses l
     SET seat_count = seat_count + p_extra_seats,
         notes = COALESCE(notes, '') ||
                 format(E'\n+%s seat%s on %s (Razorpay pay %s, prorated %s paise)',
                        p_extra_seats,
                        CASE WHEN p_extra_seats = 1 THEN '' ELSE 's' END,
                        to_char(now(), 'YYYY-MM-DD'),
                        COALESCE(p_razorpay_payment_id, '—'),
                        COALESCE(p_prorated_amount_paise::text, '—'))
   WHERE l.organization_id = p_org_id
     AND l.status = 'active'
     AND l.plan_id IN (SELECT id FROM public.plans WHERE NOT is_addon)
   RETURNING l.id INTO v_lic_id;

  IF v_lic_id IS NULL THEN
    RAISE EXCEPTION 'no active main-plan license for org %', p_org_id USING ERRCODE = 'P0002';
  END IF;

  -- Mirror seat count on organizations.license_count.
  UPDATE public.organizations
     SET license_count = license_count + p_extra_seats
   WHERE id = p_org_id
   RETURNING license_count INTO v_new_count;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (NULL, 'system', 'org.seats_added', 'organization', p_org_id,
          jsonb_build_object('extra_seats', p_extra_seats,
                             'razorpay_payment_id', p_razorpay_payment_id,
                             'prorated_paise', p_prorated_amount_paise,
                             'new_total', v_new_count));

  RETURN QUERY SELECT v_new_count, v_lic_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_seats_to_active_license(uuid, int, text, int) TO service_role;

COMMIT;
