-- 0052_list_super_admins_rpc.sql
-- Helper RPC for the /admin/users page: returns every super_admin's user_id +
-- email + full_name + created_at. We use a SECURITY DEFINER function because
-- the auth.users table isn't directly readable from PostgREST.

create or replace function public.list_super_admins()
returns table(
  user_id    uuid,
  email      text,
  full_name  text,
  granted_at timestamptz,
  last_sign_in_at timestamptz
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
    u.last_sign_in_at
  from public.app_users a
  left join auth.users u on u.id = a.user_id
  where a.app_role = 'super_admin'
  order by a.created_at asc
$$;

revoke all on function public.list_super_admins() from anon;
grant execute on function public.list_super_admins() to authenticated;
