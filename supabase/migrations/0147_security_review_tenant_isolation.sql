-- 0147_security_review_tenant_isolation.sql
--
-- Closes the tenant-isolation / authorization findings from the security
-- review that were NOT part of the 0139–0146 lockdown. All changes are grant /
-- view-option only (no data, no logic changes), so they cannot alter what a
-- legitimately-scoped caller already sees — they only remove cross-tenant
-- reach. Verified against the local DB: org members still read their own org's
-- rows through the affected views (employees / gov_pillars / directory_users
-- RLS returns the member's rows), and the seed_* functions run via the
-- SECURITY DEFINER trigger tg_seed_org_productivity_rules, so revoking direct
-- EXECUTE does not break org-creation seeding.

BEGIN;

-- ── Findings C1 / H1 / H7 — views were bypassing RLS ─────────────────────────
-- These views run as owner (postgres = BYPASSRLS) and carry no org filter, so
-- with security_invoker OFF any authenticated user (or anon) reads EVERY
-- tenant's rows. 0051 originally set security_invoker=true on v_org_users, but a
-- later `create or replace view` (0112) silently dropped the reloption. Flip it
-- back so the querying user's RLS on the base tables applies.
ALTER VIEW public.v_org_users            SET (security_invoker = true);
ALTER VIEW public.v_gov_pillars_summary  SET (security_invoker = true);
ALTER VIEW public.agent_addon_view       SET (security_invoker = true);

-- ── Finding H2 — cross-tenant WRITE via seed_* (IDOR) ────────────────────────
-- SECURITY DEFINER, default PUBLIC EXECUTE, and no caller authz in the body:
-- any user could POST rpc/seed_prohibited_rules {p_org_id:<victim>} and inject
-- rules into another tenant. They are only ever meant to run from the
-- org-creation trigger (definer → runs as owner) or the service role.
REVOKE EXECUTE ON FUNCTION public.seed_default_productivity_rules(uuid)  FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_prohibited_rules(uuid)           FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_ai_design_martech_rules(uuid)    FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_rotating_domain_rules(uuid)      FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.seed_default_productivity_rules(uuid)  TO service_role;
GRANT  EXECUTE ON FUNCTION public.seed_prohibited_rules(uuid)           TO service_role;
GRANT  EXECUTE ON FUNCTION public.seed_ai_design_martech_rules(uuid)    TO service_role;
GRANT  EXECUTE ON FUNCTION public.seed_rotating_domain_rules(uuid)      TO service_role;

-- ── Findings 5 / 6 — cross-tenant READ via DEFINER helpers ───────────────────
-- These take an org_id / employee_id and return another tenant's internal email
-- domains or an employee's manager email with no membership check. They are
-- consumed only by DLP classification SQL (SECURITY DEFINER → runs as owner) and
-- server-side jobs, never by the browser (grep-verified: no frontend caller).
REVOKE EXECUTE ON FUNCTION public.org_internal_domains(uuid)             FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.classify_recipient_scope(uuid, text[]) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.external_domains_of(uuid, text[])      FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.employee_manager_email(uuid)           FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.org_internal_domains(uuid)             TO service_role;
GRANT  EXECUTE ON FUNCTION public.classify_recipient_scope(uuid, text[]) TO service_role;
GRANT  EXECUTE ON FUNCTION public.external_domains_of(uuid, text[])      TO service_role;
GRANT  EXECUTE ON FUNCTION public.employee_manager_email(uuid)           TO service_role;

COMMIT;

-- PostgREST caches the schema; make it re-read so the new grants/view options
-- take effect immediately.
NOTIFY pgrst, 'reload schema';
