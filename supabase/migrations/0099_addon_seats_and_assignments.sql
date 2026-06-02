-- 0099_addon_seats_and_assignments.sql
--
-- Phase 4: independent seat counts + per-agent assignment for add-ons (DLP,
-- EM-addon, etc).
--
-- Model:
--   org_addons.seat_count          — how many add-on seats the org bought
--   org_addon_assignments(org_id, agent_id, addon_plan_id)
--                                   — which agents currently consume those seats
--
-- The org's main license_key does NOT change — the add-on shares the parent
-- license. We just track count + assignments separately.

BEGIN;

-- ── 1. activate_org_addon now accepts p_seats ─────────────────────────────
DROP FUNCTION IF EXISTS public.activate_org_addon(uuid, text, text);

CREATE OR REPLACE FUNCTION public.activate_org_addon(
  p_org_id uuid,
  p_addon_plan_code text,
  p_razorpay_subscription_id text,
  p_seats int DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_plan       public.plans%ROWTYPE;
  v_seats      int;
  v_existing   uuid;
BEGIN
  SELECT * INTO v_plan FROM public.plans WHERE code = p_addon_plan_code AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'addon plan_code % not found / inactive', p_addon_plan_code USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_plan.is_addon THEN
    RAISE EXCEPTION 'plan_code % is not an add-on', p_addon_plan_code USING ERRCODE = '22023';
  END IF;

  -- Default to the org's main license_count (so a 5-seat org gets 5 DLP
  -- seats unless they explicitly picked fewer/more).
  IF p_seats IS NULL OR p_seats <= 0 THEN
    SELECT license_count INTO v_seats FROM public.organizations WHERE id = p_org_id;
    IF v_seats IS NULL OR v_seats <= 0 THEN v_seats := 1; END IF;
  ELSE
    v_seats := GREATEST(1, LEAST(p_seats, 10000));
  END IF;

  SELECT id INTO v_existing
    FROM public.org_addons
   WHERE org_id = p_org_id AND plan_id = v_plan.id AND active = false
   ORDER BY started_at DESC LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE public.org_addons
       SET active = true,
           started_at = now(),
           ends_at = NULL,
           seat_count = v_seats,
           razorpay_subscription_id = p_razorpay_subscription_id
     WHERE id = v_existing;
    INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
    VALUES (NULL, 'system', 'org.addon_reactivated', 'organization', p_org_id,
            jsonb_build_object('addon_code', p_addon_plan_code, 'seats', v_seats, 'subscription_id', p_razorpay_subscription_id));
    RETURN v_existing;
  END IF;

  INSERT INTO public.org_addons (org_id, plan_id, seat_count, active, razorpay_subscription_id)
  VALUES (p_org_id, v_plan.id, v_seats, true, p_razorpay_subscription_id)
  ON CONFLICT (org_id, plan_id, active) DO UPDATE
    SET razorpay_subscription_id = EXCLUDED.razorpay_subscription_id,
        started_at = now(),
        seat_count = EXCLUDED.seat_count
  RETURNING id INTO v_existing;

  INSERT INTO public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  VALUES (NULL, 'system', 'org.addon_activated', 'organization', p_org_id,
          jsonb_build_object('addon_code', p_addon_plan_code, 'seats', v_seats, 'subscription_id', p_razorpay_subscription_id));

  RETURN v_existing;
END;
$$;

GRANT EXECUTE ON FUNCTION public.activate_org_addon(uuid, text, text, int) TO service_role;

-- ── 2. org_addon_assignments — which agents consume which add-on seats ────
CREATE TABLE IF NOT EXISTS public.org_addon_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  addon_plan_id uuid NOT NULL REFERENCES public.plans(id),
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  assigned_by   uuid REFERENCES auth.users(id),
  UNIQUE (org_id, agent_id, addon_plan_id)
);

CREATE INDEX IF NOT EXISTS org_addon_assignments_org_idx
  ON public.org_addon_assignments (org_id, addon_plan_id);

ALTER TABLE public.org_addon_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "addon_assignments_read_org_members" ON public.org_addon_assignments;
DROP POLICY IF EXISTS "addon_assignments_write_admins" ON public.org_addon_assignments;
DROP POLICY IF EXISTS "addon_assignments_delete_admins" ON public.org_addon_assignments;

-- Org members can read their own org's assignments.
CREATE POLICY "addon_assignments_read_org_members"
  ON public.org_addon_assignments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.org_members m
     WHERE m.org_id = org_addon_assignments.org_id AND m.user_id = auth.uid()
  ));

-- Owners/admins can write — but only up to the addon's seat_count.
CREATE POLICY "addon_assignments_write_admins"
  ON public.org_addon_assignments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.org_members m
       WHERE m.org_id = org_addon_assignments.org_id
         AND m.user_id = auth.uid()
         AND m.role IN ('owner','admin')
    )
    AND EXISTS (
      SELECT 1 FROM public.org_addons a
       WHERE a.org_id = org_addon_assignments.org_id
         AND a.plan_id = org_addon_assignments.addon_plan_id
         AND a.active = true
    )
  );

CREATE POLICY "addon_assignments_delete_admins"
  ON public.org_addon_assignments FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.org_members m
     WHERE m.org_id = org_addon_assignments.org_id
       AND m.user_id = auth.uid()
       AND m.role IN ('owner','admin')
  ));

-- ── 3. Seat cap: trigger that rejects INSERTs beyond the addon's seat_count
CREATE OR REPLACE FUNCTION public.enforce_addon_seat_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cap     int;
  v_taken   int;
BEGIN
  SELECT seat_count INTO v_cap
    FROM public.org_addons
   WHERE org_id = NEW.org_id AND plan_id = NEW.addon_plan_id AND active = true;
  IF v_cap IS NULL THEN
    RAISE EXCEPTION 'Add-on is not active for this organization' USING ERRCODE = '42501';
  END IF;
  SELECT COUNT(*) INTO v_taken
    FROM public.org_addon_assignments
   WHERE org_id = NEW.org_id AND addon_plan_id = NEW.addon_plan_id;
  IF v_taken >= v_cap THEN
    RAISE EXCEPTION 'Add-on seat cap reached (% seats). Buy more seats or remove an existing assignment.', v_cap
      USING ERRCODE = '53300';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_addon_seat_cap ON public.org_addon_assignments;
CREATE TRIGGER trg_enforce_addon_seat_cap
  BEFORE INSERT ON public.org_addon_assignments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_addon_seat_cap();

-- ── 4. Helper view: which agents have which add-ons (easy to query) ───────
CREATE OR REPLACE VIEW public.agent_addon_view AS
SELECT
  a.org_id,
  a.agent_id,
  p.code   AS addon_code,
  p.name   AS addon_name,
  a.assigned_at
FROM public.org_addon_assignments a
JOIN public.plans p ON p.id = a.addon_plan_id;

GRANT SELECT ON public.agent_addon_view TO authenticated, service_role;

COMMIT;
