-- 0109_billing_entity_and_auto_invoice.sql
--
-- Three related changes:
--
--   1. Singleton `billing_entity` row — Rudrans's company info that appears
--      as the "Bill From" entity on every customer invoice. Super admin edits
--      this from /admin/billing-entity instead of hardcoded constants in the
--      frontend.
--
--   2. Auto-invoice on every payment: `generate_billing_invoice()` RPC that
--      payment-verify edge fns call. Allocates next invoice_number, computes
--      GST split, inserts invoices row marked paid.
--
--   3. Super-admin addon helpers: grant_addon_admin / revoke_addon_admin so
--      support can fix orgs (like Som Info) without raw SQL.

BEGIN;

-- ── 1. billing_entity (single row, super-admin-managed) ──────────────────
CREATE TABLE IF NOT EXISTS public.billing_entity (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
  legal_name    text NOT NULL,
  brand_name    text,
  gst_number    text,
  pan_number    text,
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  postal_code   text,
  country       text NOT NULL DEFAULT 'India',
  contact_email text,
  phone         text,
  website       text,
  bank_name     text,
  bank_account_number text,
  bank_ifsc     text,
  invoice_prefix text NOT NULL DEFAULT 'RDR',
  invoice_next_number bigint NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES auth.users(id)
);

INSERT INTO public.billing_entity (
  id, legal_name, brand_name, address_line1, city, state, postal_code,
  contact_email, country, invoice_prefix
)
VALUES (
  1,
  'Rudrans Technologies Pvt Ltd',
  'Rudrans',
  'Floor 4, Tower B, iThum Business Park',
  'Noida', 'Uttar Pradesh', '201309',
  'billing@wellnessextract.com', 'India',
  'RDR'
)
ON CONFLICT (id) DO NOTHING;

-- RLS: super_admin can read/write; everyone else can READ ONLY (so customer
-- invoice templates can show the "From" entity).
ALTER TABLE public.billing_entity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "billing_entity_read_all" ON public.billing_entity;
CREATE POLICY "billing_entity_read_all"
  ON public.billing_entity FOR SELECT USING (true);

DROP POLICY IF EXISTS "billing_entity_write_super_admin" ON public.billing_entity;
CREATE POLICY "billing_entity_write_super_admin"
  ON public.billing_entity FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.app_users WHERE user_id = auth.uid() AND app_role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.app_users WHERE user_id = auth.uid() AND app_role = 'super_admin'));

DROP POLICY IF EXISTS "billing_entity_block_inserts" ON public.billing_entity;
CREATE POLICY "billing_entity_block_inserts"
  ON public.billing_entity FOR INSERT WITH CHECK (false);

DROP POLICY IF EXISTS "billing_entity_block_deletes" ON public.billing_entity;
CREATE POLICY "billing_entity_block_deletes"
  ON public.billing_entity FOR DELETE USING (false);

-- ── 2. generate_billing_invoice ──────────────────────────────────────────
-- Called by every payment-verify edge fn after Razorpay confirms a charge.
-- Inserts an invoices row already marked paid. Returns the new invoice row.
CREATE OR REPLACE FUNCTION public.generate_billing_invoice(
  p_org_id uuid,
  p_amount_inr numeric,      -- GROSS amount paid (already includes GST)
  p_plan_id uuid DEFAULT NULL,
  p_license_id uuid DEFAULT NULL,
  p_razorpay_order_id text DEFAULT NULL,
  p_razorpay_payment_id text DEFAULT NULL,
  p_kind text DEFAULT 'subscription',   -- subscription | upgrade | addon | seats | renewal | trial_verify
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
  -- Idempotency: if an invoice already exists for this razorpay_payment_id,
  -- return it rather than creating a duplicate. Lets the verify-endpoint
  -- AND the safety-net webhook both call generate_billing_invoice without
  -- double-billing the customer.
  IF p_razorpay_payment_id IS NOT NULL THEN
    SELECT id INTO v_inv_id FROM public.invoices
     WHERE razorpay_payment_id = p_razorpay_payment_id LIMIT 1;
    IF v_inv_id IS NOT NULL THEN
      RETURN v_inv_id;
    END IF;
  END IF;

  SELECT * INTO v_be FROM public.billing_entity WHERE id = 1;

  -- GST 18% breakdown (defensive: assume p_amount_inr is GROSS).
  v_total := COALESCE(p_amount_inr, 0)::numeric(10,2);
  v_amount_excl := ROUND(v_total / 1.18, 2);
  v_gst         := ROUND(v_total - v_amount_excl, 2);

  -- Next invoice number (RDR-2026-000001 style).
  UPDATE public.billing_entity
     SET invoice_next_number = invoice_next_number + 1
   WHERE id = 1
   RETURNING invoice_next_number - 1 INTO v_seq;
  v_number := format('%s-%s-%s', v_be.invoice_prefix, to_char(now(), 'YYYY'), lpad(v_seq::text, 6, '0'));

  -- Partner (channel) → carries commission for the books.
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
    now(), now(), p_kind, 'trackforce', COALESCE(p_is_renewal, false)
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

GRANT EXECUTE ON FUNCTION public.generate_billing_invoice(uuid, numeric, uuid, uuid, text, text, text, boolean) TO service_role;

-- ── 3. grant_addon_admin / revoke_addon_admin ────────────────────────────
-- Super-admin tools. Use the existing activate_org_addon path so audit log
-- + uniqueness rules stay consistent.
CREATE OR REPLACE FUNCTION public.grant_addon_admin(
  p_org_id uuid,
  p_addon_plan_code text,
  p_seats int DEFAULT 1,
  p_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid;
  v_id     uuid;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.app_users WHERE user_id = v_caller AND app_role = 'super_admin') THEN
      RAISE EXCEPTION 'super admin required' USING ERRCODE = '42501';
    END IF;
  END IF;
  v_id := public.activate_org_addon(p_org_id, p_addon_plan_code,
                                    format('admin_grant_%s', to_char(now(), 'YYYYMMDDHH24MISS')),
                                    p_seats);
  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (v_caller, 'super_admin', 'org.addon_granted_manual', 'organization', p_org_id,
          jsonb_build_object('addon_code', p_addon_plan_code, 'seats', p_seats, 'reason', p_reason));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_addon_admin(
  p_org_id uuid,
  p_addon_plan_code text,
  p_reason text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid;
  v_n int;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.app_users WHERE user_id = v_caller AND app_role = 'super_admin') THEN
      RAISE EXCEPTION 'super admin required' USING ERRCODE = '42501';
    END IF;
  END IF;
  WITH upd AS (
    UPDATE public.org_addons a
       SET active = false, ends_at = now()
     WHERE a.org_id = p_org_id
       AND a.active = true
       AND a.plan_id = (SELECT id FROM public.plans WHERE code = p_addon_plan_code)
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;

  -- Also drop any agent assignments for that addon.
  DELETE FROM public.org_addon_assignments
   WHERE org_id = p_org_id
     AND addon_plan_id = (SELECT id FROM public.plans WHERE code = p_addon_plan_code);

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (v_caller, 'super_admin', 'org.addon_revoked_manual', 'organization', p_org_id,
          jsonb_build_object('addon_code', p_addon_plan_code, 'rows', v_n, 'reason', p_reason));
  RETURN v_n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_addon_admin(uuid, text, int, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_addon_admin(uuid, text, text) TO authenticated, service_role;

COMMIT;
