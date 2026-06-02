-- 0098_grace_and_time_extension.sql
--
-- Phase 2 + 3 of the trial UX:
--   • 7-day grace window after trial_ends_at — full access continues, banner
--     warns the customer that auto-charge is N days away.
--   • Customer can request a 15-day TIME extension during trial OR grace.
--     Super admin approves → trial_ends_at pushes out by 15 days. Razorpay
--     auto-charge fires 7 days after the new trial_ends_at.
--   • Trial-time plan switch (Phase 2) shares the swap_org_plan-style code
--     path but creates a NEW Razorpay subscription with ₹2 addon and
--     start_at = new trial_ends_at + 7 days.
--
-- Existing `trial_extension_requests` was originally a "full-features access"
-- request bucket. We add a `kind` column to multiplex both flavours.

BEGIN;

-- ── 1. trial_extension_requests: add `kind` + `days_requested` ────────────
ALTER TABLE public.trial_extension_requests
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'feature_access',
  ADD COLUMN IF NOT EXISTS days_requested int;

ALTER TABLE public.trial_extension_requests
  DROP CONSTRAINT IF EXISTS trial_extension_requests_kind_check;
ALTER TABLE public.trial_extension_requests
  ADD CONSTRAINT trial_extension_requests_kind_check
    CHECK (kind IN ('feature_access', 'time_extension'));

-- ── 2. is_subscription_active: extend trial by 7-day grace window ────────
-- The single source of truth for "can this org still use the product".
CREATE OR REPLACE FUNCTION public.is_subscription_active(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  -- Active if:
  --   subscription_status NOT in ('expired','suspended','cancelled') AND
  --   (status != 'trial' OR trial_ends_at + interval '7 days' > now()) AND
  --   at least one active license.
  SELECT COALESCE((
    SELECT
      o.subscription_status NOT IN ('expired','suspended','cancelled')
      AND (o.subscription_status <> 'trial' OR (o.trial_ends_at + interval '7 days') > now())
      AND EXISTS (
        SELECT 1 FROM public.licenses l
        WHERE l.organization_id = o.id
          AND l.status = 'active'
      )
    FROM public.organizations o
    WHERE o.id = p_org_id
  ), false);
$$;

-- ── 3. org_effective_features: during grace, keep returning trial features
-- (no change needed — current function reads subscription_status, and orgs
-- stay 'trial' during grace until they pay).
-- But we DO want to make sure the function tolerates trial_ends_at being in
-- the past — current impl already does, since it only looks at status.

-- ── 4. RPC: approve_trial_time_extension ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_trial_time_extension(
  p_request_id uuid,
  p_super_admin_id uuid,
  p_decision_note text DEFAULT NULL
)
RETURNS TABLE(org_id uuid, new_trial_ends_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_req         public.trial_extension_requests%ROWTYPE;
  v_days        int;
  v_new_end     timestamptz;
BEGIN
  SELECT * INTO v_req FROM public.trial_extension_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'request already %', v_req.status USING ERRCODE = '22023';
  END IF;
  IF v_req.kind <> 'time_extension' THEN
    RAISE EXCEPTION 'request is not a time_extension (kind=%)', v_req.kind USING ERRCODE = '22023';
  END IF;

  v_days := COALESCE(v_req.days_requested, 15);
  IF v_days <= 0 OR v_days > 90 THEN
    RAISE EXCEPTION 'days_requested out of range: %', v_days USING ERRCODE = '22023';
  END IF;

  -- Push trial_ends_at by the granted days, taking max(now, trial_ends_at)
  -- so customers in grace get a meaningful extension.
  UPDATE public.organizations
     SET trial_ends_at = GREATEST(now(), trial_ends_at) + (v_days || ' days')::interval
   WHERE id = v_req.org_id
   RETURNING trial_ends_at INTO v_new_end;

  UPDATE public.trial_extension_requests
     SET status = 'approved',
         decided_by = p_super_admin_id,
         decided_at = now(),
         decision_note = p_decision_note
   WHERE id = p_request_id;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (p_super_admin_id, 'super_admin', 'trial.time_extension.approved', 'organization', v_req.org_id,
          jsonb_build_object('request_id', p_request_id, 'days', v_days, 'new_trial_ends_at', v_new_end));

  RETURN QUERY SELECT v_req.org_id, v_new_end;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_trial_time_extension(uuid, uuid, text) TO service_role;

-- ── 5. RPC: swap_trial_plan (for Phase 2 — trial-time plan change) ────────
-- Like swap_org_plan but the org stays in 'trial' status; just changes the
-- plan code, the trial license seat_count stays, and razorpay_subscription_id
-- updates to the new Razorpay sub.
CREATE OR REPLACE FUNCTION public.swap_trial_plan(
  p_org_id uuid,
  p_new_plan_code text,
  p_razorpay_subscription_id text,
  p_razorpay_customer_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_plan       public.plans%ROWTYPE;
  v_lic_id     uuid;
  v_seats      int;
  v_trial_end  timestamptz;
BEGIN
  SELECT * INTO v_plan FROM public.plans WHERE code = p_new_plan_code AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan_code % not found / inactive', p_new_plan_code USING ERRCODE = 'P0002';
  END IF;
  IF v_plan.is_addon THEN
    RAISE EXCEPTION 'plan_code % is an add-on', p_new_plan_code USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(license_count, 25), trial_ends_at INTO v_seats, v_trial_end
    FROM public.organizations WHERE id = p_org_id;
  IF v_trial_end IS NULL THEN
    RAISE EXCEPTION 'org % is not on a trial', p_org_id USING ERRCODE = '22023';
  END IF;

  -- Expire the current active main-plan license, create a fresh one on the
  -- new plan with the same trial end date and seat count.
  UPDATE public.licenses
     SET status = 'expired'
   WHERE organization_id = p_org_id AND status = 'active'
     AND plan_id IN (SELECT id FROM public.plans WHERE NOT is_addon);

  INSERT INTO public.licenses (organization_id, plan_id, seat_count, status, expires_at, notes)
  VALUES (p_org_id, v_plan.id, v_seats, 'active', v_trial_end,
          format('Trial plan switched to %s (Razorpay sub %s)', p_new_plan_code, p_razorpay_subscription_id))
  RETURNING id INTO v_lic_id;

  UPDATE public.organizations
     SET trial_plan_code        = p_new_plan_code,
         subscription_type      = v_plan.billing_cycle,
         razorpay_subscription_id = p_razorpay_subscription_id,
         razorpay_customer_id     = COALESCE(p_razorpay_customer_id, razorpay_customer_id)
   WHERE id = p_org_id;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (NULL, 'system', 'trial.plan_switched', 'organization', p_org_id,
          jsonb_build_object('new_plan_code', p_new_plan_code, 'subscription_id', p_razorpay_subscription_id));

  RETURN v_lic_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.swap_trial_plan(uuid, text, text, text) TO service_role;

COMMIT;
