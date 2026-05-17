-- 0055_org_role_write_gating.sql
-- Layer org_members.role onto RLS so "viewer" members can only READ while
-- "admin" / "owner" can WRITE. This applies to every customer-facing table —
-- employees, directory_users/groups/group_members, credentials,
-- hardware_assets, offboardings, etc.
--
-- Read access stays org-scoped (already gated by user_org_ids()). Writes now
-- additionally check is_org_writer(org_id) which returns true only for owner
-- or admin members. The companion frontend hook useOrgRole() hides write
-- controls for viewers so they don't try.

create or replace function public.user_org_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.org_members
   where org_id = p_org and user_id = auth.uid()
   limit 1
$$;

create or replace function public.is_org_writer(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('owner', 'admin') from public.org_members
       where org_id = p_org and user_id = auth.uid() limit 1),
    false
  )
$$;

grant execute on function public.user_org_role(uuid) to authenticated;
grant execute on function public.is_org_writer(uuid) to authenticated;

-- ============== employees ==============
drop policy if exists employees_write on public.employees;
create policy employees_write on public.employees
  for all using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

-- ============== directory_users + groups + group_members ==============
-- Direct writes are rare (we mostly mutate via Graph + sync), but customer
-- admins do flip account_enabled / suspended via direct UPDATE in the
-- employees page. Gate that with is_org_writer too.
drop policy if exists directory_users_write on public.directory_users;
create policy directory_users_write on public.directory_users
  for update using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

drop policy if exists directory_groups_write on public.directory_groups;
create policy directory_groups_write on public.directory_groups
  for update using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

-- ============== credentials ==============
drop policy if exists credentials_write on public.credentials;
create policy credentials_write on public.credentials
  for all using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

drop policy if exists credential_requests_write on public.credential_requests;
create policy credential_requests_write on public.credential_requests
  for all using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

-- ============== hardware ==============
drop policy if exists hardware_assets_write on public.hardware_assets;
create policy hardware_assets_write on public.hardware_assets
  for all using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

drop policy if exists hardware_assignments_write on public.hardware_assignments;
create policy hardware_assignments_write on public.hardware_assignments
  for all using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

-- ============== offboarding ==============
drop policy if exists offboardings_write on public.offboardings;
create policy offboardings_write on public.offboardings
  for all using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

-- ============== org-level settings ==============
-- organizations: only the owner can change profile / billing fields. The
-- existing org_update policy already gates this via owner_user_id = auth.uid().
-- org_members: only writers can invite / edit / remove. Inserts also via
-- edge functions (service role) which bypass RLS.
drop policy if exists members_write on public.org_members;
create policy members_write on public.org_members
  for all using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));

-- ============== departments / groups ==============
drop policy if exists org_departments_write on public.org_departments;
create policy org_departments_write on public.org_departments
  for all using (public.is_org_writer(org_id))
  with check (public.is_org_writer(org_id));
