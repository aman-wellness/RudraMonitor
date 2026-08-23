-- 0142_lockdown_dangerous_rpcs_round2.sql
--
-- SECURITY FIX round 2 (re-audit findings). The re-audit confirmed 0139 held
-- for the 16 functions it named, but found MORE functions of the same class
-- that were omitted — still EXECUTE-able by the anonymous public key:
--
--   CRITICAL:
--     mark_invoice_paid(uuid,text,text)        — no guard: anon marks any
--         invoice paid, activates the license, extends it a billing cycle.
--     extend_license_renewal(uuid,int,timestamptz) — null-uid bypass: anon
--         extends any license and reactivates the org.
--   MEDIUM:
--     finalize_pending_signup / _v2            — service-role signup finalizers.
--     auto_invoice_digest_tick / invoice_digest_tick / invoice_fetch_tick /
--         directory_sync_tick / invoice_fetch_enqueue — cron/HTTP job triggers.
--     get_storage_stats()                      — cross-tenant storage figures.
--
-- Same approach as 0139: cut PUBLIC + anon everywhere; cut authenticated too on
-- the server-only ones. Callers verified in the repo:
--   * extend_license_renewal, get_storage_stats → called from the super-admin
--     dashboard (authenticated) → keep authenticated + service_role.
--   * mark_invoice_paid, finalize_pending_signup(_v2) → called by edge/webhook
--     (service_role) → service_role only.
--   * the tick/enqueue cluster → cron / net.http (service_role) → service_role only.
--
-- NOTE on extend_license_renewal's null-uid guard branch: revoking anon EXECUTE
-- closes the anonymous path (the exploit). It stays reachable by authenticated
-- super-admins (real non-null uid → its super_admin check runs) and by
-- service_role. Rewriting its body to drop the null-uid branch is a follow-up.

do $$
declare
  r record;
  svc_only text[] := array[
    'mark_invoice_paid', 'finalize_pending_signup', 'finalize_pending_signup_v2',
    'auto_invoice_digest_tick', 'invoice_digest_tick', 'invoice_fetch_tick',
    'directory_sync_tick', 'invoice_fetch_enqueue'
  ];
  auth_ok text[] := array['extend_license_renewal', 'get_storage_stats'];
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname = any(svc_only) or p.proname = any(auth_ok))
  loop
    execute format('revoke execute on function %s from public;', r.sig);
    execute format('revoke execute on function %s from anon;', r.sig);
    if r.proname = any(svc_only) then
      execute format('revoke execute on function %s from authenticated;', r.sig);
      execute format('grant execute on function %s to service_role;', r.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role;', r.sig);
    end if;
    raise notice 'r2 locked down %', r.sig;
  end loop;
end $$;

-- Residuals tracked in AUDIT_FIX_TRACKER.md (not closed here, lower harm):
--   * get_storage_stats / list_super_admins / directory_setup_info remain
--     callable by any AUTHENTICATED user (no in-function role guard). Anon is
--     closed. Adding a super-admin guard to each is a follow-up.
--   * seed_* helpers and org_claim_by_email are left as-is: org_claim_by_email
--     may be needed by the unauthenticated signup flow, so revoking anon risks
--     breaking onboarding — needs deliberate signup-flow verification first.
