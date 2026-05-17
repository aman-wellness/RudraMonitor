-- 0053_list_super_admins_with_banned.sql
-- Extend list_super_admins() to surface whether the account is currently
-- banned (sign-in disabled). The /admin/users UI uses this to show a
-- "Disabled" pill + flip the Disable/Enable action.

drop function if exists public.list_super_admins();

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
  order by a.created_at asc
$$;

grant execute on function public.list_super_admins() to authenticated;
