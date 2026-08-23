-- 0144_guard_super_admin_and_directory_info.sql
--
-- FIX (audit residuals from 0139/0142). Both functions had their anonymous
-- access revoked, but remained callable by ANY authenticated user with no
-- in-function guard:
--   * list_super_admins() leaked the whole super-admin roster (emails, names,
--     last sign-in) to any logged-in user of any tenant — ideal phishing recon.
--   * directory_setup_info() leaked Google/M365 integration client IDs + the SA
--     client email to any logged-in user.
--
-- These are SQL functions, so the guard is a WHERE EXISTS that returns ZERO
-- rows to unauthorised callers (same pattern get_storage_stats uses):
--   * list_super_admins → caller must themselves be a super_admin.
--   * directory_setup_info → caller must be an owner/admin of some org (the
--     people who actually configure the directory integration); the values are
--     non-secret client identifiers, so org-admin scope is the right bar.
--
-- CREATE OR REPLACE preserves the ACL, but re-assert the lockdown explicitly so
-- this migration is self-contained regardless of prior grant state.

create or replace function public.list_super_admins()
returns table(
  user_id        uuid,
  email          text,
  full_name      text,
  granted_at     timestamptz,
  last_sign_in_at timestamptz,
  is_disabled    boolean
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    a.user_id,
    u.email::text                                       as email,
    coalesce(u.raw_user_meta_data->>'full_name', '')    as full_name,
    a.created_at                                        as granted_at,
    u.last_sign_in_at,
    (u.banned_until is not null and u.banned_until > now()) as is_disabled
  from public.app_users a
  left join auth.users u on u.id = a.user_id
  where a.app_role = 'super_admin'
    -- Guard: only a super_admin may read the roster.
    and exists (
      select 1 from public.app_users me
      where me.user_id = auth.uid() and me.app_role = 'super_admin'
    )
  order by a.created_at asc
$$;

create or replace function public.directory_setup_info()
returns table(
  google_sa_client_id   text,
  google_sa_client_email text,
  google_scopes         text[],
  m365_client_id        text,
  m365_scopes           text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select value from public.integrations where key = 'GOOGLE_SA_CLIENT_ID')        as google_sa_client_id,
    (select value from public.integrations where key = 'GOOGLE_SA_CLIENT_EMAIL')     as google_sa_client_email,
    array[
      'https://www.googleapis.com/auth/admin.directory.user',
      'https://www.googleapis.com/auth/admin.directory.group',
      'https://www.googleapis.com/auth/admin.directory.group.member',
      'https://www.googleapis.com/auth/admin.directory.domain.readonly',
      'https://www.googleapis.com/auth/admin.directory.orgunit',
      'https://www.googleapis.com/auth/gmail.send'
    ]::text[] as google_scopes,
    (select value from public.integrations where key = 'DIRECTORY_M365_CLIENT_ID')   as m365_client_id,
    array[
      'User.ReadWrite.All',
      'Group.ReadWrite.All',
      'GroupMember.ReadWrite.All',
      'Directory.ReadWrite.All',
      'Organization.Read.All',
      'Domain.Read.All',
      'Mail.Send'
    ]::text[] as m365_scopes
  -- Guard: only an org owner/admin (a real customer admin) may read this.
  where exists (
    select 1 from public.org_members m
    where m.user_id = auth.uid() and m.role in ('owner', 'admin')
  )
$$;

revoke execute on function public.list_super_admins() from public, anon;
grant execute on function public.list_super_admins() to authenticated, service_role;
revoke execute on function public.directory_setup_info() from public, anon;
grant execute on function public.directory_setup_info() to authenticated, service_role;
