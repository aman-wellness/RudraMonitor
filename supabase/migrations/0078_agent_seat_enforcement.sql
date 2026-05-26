-- Hard seat enforcement.
--
-- Until now, license_count was an honour-system field — agents enrolled
-- past the seat limit kept happily ingesting data and showing up in the
-- dashboard. The customer would over-provision (e.g. seat_count=1 but
-- 3 machines enrolled) and we'd never push back. Worse, when a customer
-- downgrades their plan (5 → 1 seat) those extra agents kept working.
--
-- New rule: agents are ordered by created_at ASC; the FIRST seat_count
-- of them are "in license" and may enrol, ingest, validate. Everything
-- after that is "locked" — enrolment fails with 402, all ingest endpoints
-- refuse data, and the dashboard hides their stream. Upgrade the seat
-- count to unlock them; downgrade to lock the newest ones.
--
-- The cap is read from the active license's seat_count (falls back to
-- organizations.license_count for legacy rows without an active license).

BEGIN;

-- Resolves the effective seat cap for an org. Service-role callers (edge
-- functions) and the dashboard both consume this.
CREATE OR REPLACE FUNCTION public.org_seat_cap(p_org_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT seat_count
       FROM public.licenses
      WHERE organization_id = p_org_id AND status = 'active'
      ORDER BY issued_at DESC LIMIT 1),
    (SELECT license_count FROM public.organizations WHERE id = p_org_id),
    0
  )::int
$$;

-- True if this agent is within the org's seat cap, ordered by enrolment
-- time ASC. The oldest seat_count agents are in-license; the rest are
-- locked. Stable ordering on created_at + id breaks ties deterministically
-- so the same agent doesn't flip in/out across reads.
CREATE OR REPLACE FUNCTION public.agent_seat_ok(p_agent_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   uuid;
  v_cap   int;
  v_rank  int;
BEGIN
  SELECT org_id INTO v_org FROM public.agents WHERE id = p_agent_id;
  IF v_org IS NULL THEN RETURN FALSE; END IF;
  v_cap := public.org_seat_cap(v_org);
  IF v_cap <= 0 THEN RETURN FALSE; END IF;
  SELECT rnk INTO v_rank FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rnk
      FROM public.agents WHERE org_id = v_org
  ) t WHERE t.id = p_agent_id;
  RETURN v_rank IS NOT NULL AND v_rank <= v_cap;
END$$;

GRANT EXECUTE ON FUNCTION public.org_seat_cap(uuid)  TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.agent_seat_ok(uuid) TO authenticated, anon, service_role;

-- Convenience view: agents with a computed "locked" flag so the dashboard
-- can dim/hide the over-cap rows without re-running the rank query in JS.
CREATE OR REPLACE VIEW public.agents_with_seat AS
  SELECT a.*,
         ROW_NUMBER() OVER (PARTITION BY a.org_id ORDER BY a.created_at ASC, a.id ASC) AS seat_rank,
         (ROW_NUMBER() OVER (PARTITION BY a.org_id ORDER BY a.created_at ASC, a.id ASC)
            > public.org_seat_cap(a.org_id)) AS seat_locked
    FROM public.agents a;
ALTER VIEW public.agents_with_seat SET (security_invoker = true);
GRANT SELECT ON public.agents_with_seat TO authenticated, anon;

COMMIT;
