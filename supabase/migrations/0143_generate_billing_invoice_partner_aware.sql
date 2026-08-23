-- 0143_generate_billing_invoice_partner_aware.sql
--
-- FIX (audit M6). `generate_billing_invoice` resolves the org's partner
-- (v_partner_id) for commission, but hard-codes bill_from = 'trackforce' on the
-- INSERT. So every freshly generated invoice for a partner-routed customer is
-- tagged 'trackforce', and the partner portal (which filters bill_from='partner')
-- never shows them — 0140 only backfilled EXISTING rows. This makes the RPC
-- itself partner-aware: bill_from = 'partner' when the org has a partner.
--
-- Identical to the 0109 definition except the single bill_from expression.

CREATE OR REPLACE FUNCTION public.generate_billing_invoice(
  p_org_id uuid,
  p_amount_inr numeric,
  p_plan_id uuid DEFAULT NULL,
  p_license_id uuid DEFAULT NULL,
  p_razorpay_order_id text DEFAULT NULL,
  p_razorpay_payment_id text DEFAULT NULL,
  p_kind text DEFAULT 'subscription',
  p_is_renewal boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_be            public.billing_entity%ROWTYPE;
  v_inv_id        uuid;
  v_number        text;
  v_seq           bigint;
  v_partner_id    uuid;
  v_amount_excl   numeric(10,2);
  v_gst           numeric(10,2);
  v_total         numeric(10,2);
  v_commission_pct numeric(5,2);
  v_commission    numeric(10,2) := 0;
BEGIN
  IF p_razorpay_payment_id IS NOT NULL THEN
    SELECT id INTO v_inv_id FROM public.invoices
     WHERE razorpay_payment_id = p_razorpay_payment_id LIMIT 1;
    IF v_inv_id IS NOT NULL THEN
      RETURN v_inv_id;
    END IF;
  END IF;

  SELECT * INTO v_be FROM public.billing_entity WHERE id = 1;

  v_total := COALESCE(p_amount_inr, 0)::numeric(10,2);
  v_amount_excl := ROUND(v_total / 1.18, 2);
  v_gst         := ROUND(v_total - v_amount_excl, 2);

  UPDATE public.billing_entity
     SET invoice_next_number = invoice_next_number + 1
   WHERE id = 1
   RETURNING invoice_next_number - 1 INTO v_seq;
  v_number := format('%s-%s-%s', v_be.invoice_prefix, to_char(now(), 'YYYY'), lpad(v_seq::text, 6, '0'));

  SELECT partner_id INTO v_partner_id FROM public.organizations WHERE id = p_org_id;
  IF v_partner_id IS NOT NULL THEN
    SELECT commission_pct INTO v_commission_pct FROM public.partners WHERE id = v_partner_id;
    IF v_commission_pct IS NOT NULL THEN
      v_commission := ROUND(v_amount_excl * v_commission_pct / 100.0, 2);
    END IF;
  END IF;

  INSERT INTO public.invoices (
    invoice_number, organization_id, partner_id, license_id, plan_id,
    amount_inr, gst_pct, gst_amount_inr, total_inr,
    partner_commission_inr, status,
    razorpay_order_id, razorpay_payment_id,
    issued_at, paid_at, notes, bill_from, is_renewal
  )
  VALUES (
    v_number, p_org_id, v_partner_id, p_license_id, p_plan_id,
    v_amount_excl, 18.00, v_gst, v_total,
    v_commission, 'paid',
    p_razorpay_order_id, p_razorpay_payment_id,
    -- FIX (M6): partner-routed invoices are billed 'partner', not 'trackforce'.
    now(), now(), p_kind,
    CASE WHEN v_partner_id IS NOT NULL THEN 'partner' ELSE 'trackforce' END,
    COALESCE(p_is_renewal, false)
  )
  RETURNING id INTO v_inv_id;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (NULL, 'system', 'invoice.generated', 'organization', p_org_id,
          jsonb_build_object(
            'invoice_id', v_inv_id, 'invoice_number', v_number,
            'amount_inr', v_amount_excl, 'gst_inr', v_gst, 'total_inr', v_total,
            'kind', p_kind, 'razorpay_payment_id', p_razorpay_payment_id));

  RETURN v_inv_id;
END;
$$;

-- Preserve the lockdown posture from 0139/0142: service_role only.
REVOKE EXECUTE ON FUNCTION public.generate_billing_invoice(uuid, numeric, uuid, uuid, text, text, text, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_billing_invoice(uuid, numeric, uuid, uuid, text, text, text, boolean) TO service_role;
