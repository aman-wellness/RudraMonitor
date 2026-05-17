-- 0051_views_security_invoker.sql
-- CRITICAL multi-tenancy fix.
--
-- All our `v_*` views were created without `security_invoker = true`, which
-- means Postgres runs them as the view OWNER (postgres) and IGNORES the
-- underlying tables' RLS. Result: any authenticated user could SELECT from
-- v_org_users / v_employee_cred_history / etc. and see EVERY tenant's data.
--
-- security_invoker=true makes the view honor the calling user's RLS context,
-- which is what we want for a multi-tenant SaaS — the same RLS policies that
-- protect the base tables (employees, directory_users, credentials, etc.)
-- now apply when reading through these views too.
--
-- Applied idempotently — safe to re-run.

alter view if exists public.v_org_users               set (security_invoker = true);
alter view if exists public.v_employee_cred_history   set (security_invoker = true);
alter view if exists public.v_credential_access       set (security_invoker = true);
alter view if exists public.v_employee_with_team_size set (security_invoker = true);
alter view if exists public.v_credential_invoices     set (security_invoker = true);
alter view if exists public.credentials_safe          set (security_invoker = true);
alter view if exists public.org_integrations_safe     set (security_invoker = true);
alter view if exists public.organizations_with_features set (security_invoker = true);
