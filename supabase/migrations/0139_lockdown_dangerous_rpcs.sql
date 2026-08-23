-- 0139_lockdown_dangerous_rpcs.sql
--
-- SECURITY FIX (audit findings C1 / H5 / H6 / M25 / L20).
--
-- THE HOLE: Postgres grants EXECUTE to PUBLIC on every new function, and the
-- migrations never revoked it. Combined with SECURITY DEFINER, that let the
-- ANONYMOUS api role (the public anon key that ships in every client) call
-- powerful admin/billing/destructive functions directly. Several of those also
-- treat `auth.uid() IS NULL` as "trusted service role" — but the anon role also
-- has a null uid, so their internal guard was a no-op for anonymous callers.
--
-- Verified by the audit as the anon role: purge_org_data, trackforce_purge_old_data,
-- swap_org_plan, the billing/seat/trial/addon cluster, list_super_admins, and
-- find_auth_user_id_by_email were all reachable anonymously.
--
-- THE FIX: cut off PUBLIC + anon EXECUTE on these functions. This is the
-- load-bearing change and it cannot break the real callers:
--   • Edge functions call via the SERVICE_ROLE key (DB role `service_role`),
--     which keeps EXECUTE — so server-side billing/enrollment paths are intact.
--   • Super-admin dashboard actions run as the `authenticated` role with a real
--     (non-null) auth.uid(), so their in-function super-admin guard still runs
--     and still passes for super admins / rejects everyone else.
-- Anonymous callers now get "permission denied for function", full stop.
--
-- Two groups, based on who legitimately calls each (verified against the
-- frontend and edge-function source):
--   A) SERVICE-ROLE ONLY — only edge functions / cron call these; no browser
--      use. Revoke from anon, PUBLIC AND authenticated; leave service_role.
--   B) SUPER-ADMIN BROWSER + service — a super-admin calls these from the
--      dashboard (real login), and/or an edge function does. Revoke anon +
--      PUBLIC; keep authenticated + service_role (the in-function guard gates
--      non-admins, and anon can no longer reach them at all).

do $$
declare
  r record;
  -- Called only by edge functions / cron (service_role). No frontend rpc() use.
  svc_only text[] := array[
    'trackforce_purge_old_data', 'swap_org_plan', 'add_seats_to_active_license',
    'activate_org_addon', 'approve_trial_time_extension', 'swap_trial_plan',
    'generate_billing_invoice', 'halt_subscription', 'extend_subscription_charged',
    'sync_active_license_seat_count', 'find_auth_user_id_by_email'
  ];
  -- Called by super-admin dashboard pages (authenticated) and/or edge functions.
  auth_ok text[] := array[
    'purge_org_data', 'grant_addon_admin', 'revoke_addon_admin',
    'list_super_admins', 'directory_setup_info'
  ];
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname = any(svc_only) or p.proname = any(auth_ok))
  loop
    -- Always cut anonymous + PUBLIC.
    execute format('revoke execute on function %s from public;', r.sig);
    execute format('revoke execute on function %s from anon;', r.sig);
    if r.proname = any(svc_only) then
      -- Server-only: also cut logged-in users; only the service role remains.
      execute format('revoke execute on function %s from authenticated;', r.sig);
      execute format('grant execute on function %s to service_role;', r.sig);
    else
      -- Super-admin browser callers keep authenticated; the function's own
      -- guard restricts to super admins. Service role kept for edge callers.
      execute format('grant execute on function %s to authenticated, service_role;', r.sig);
    end if;
    raise notice 'locked down %', r.sig;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- M25: pin search_path on the SECURITY DEFINER helpers used inside RLS
-- policies. Without a fixed search_path a manipulated one could hijack how
-- unqualified names resolve inside these definer functions. ALTER only — no
-- behaviour change, no recreate.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef                                   -- security definer only
      and p.proname = any(array[
        'is_super_admin', 'current_partner_id', '_assert_super_admin',
        'handle_new_user_role', 'handle_new_org_dlp_defaults',
        'organizations_seed_email_domain'
      ])
      and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path%'
  loop
    execute format('alter function %s set search_path = public, pg_temp;', r.sig);
    raise notice 'pinned search_path on %', r.sig;
  end loop;
end $$;

-- NOTE (residual, tracked): `list_super_admins` and `directory_setup_info` are
-- still callable by ANY authenticated user (they have no internal super-admin
-- guard of their own). The anonymous hole — the Critical part — is closed here.
-- Adding an in-function super-admin/role guard to those two is a follow-up that
-- requires recreating them with their full body; see AUDIT_FIX_TRACKER.md.
--
-- SYSTEMIC follow-up (not done here, needs careful enumeration): the audit found
-- 70+ SECURITY DEFINER functions still granted to PUBLIC/anon. A blanket
-- `revoke execute on all functions in schema public from anon` + a vetted
-- allow-list for the few genuinely-public RPCs is the systemic hardening; it is
-- deferred because mis-revoking a real public flow (trial signup, etc.) would
-- break onboarding, and that enumeration must be done deliberately.
