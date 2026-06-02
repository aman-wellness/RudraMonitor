-- Allow org owners/admins to update credential_assignments rows directly
-- from the client. The only field they meaningfully change today is
-- revoked_at / revoked_reason — the "Revoke access" button on the
-- Credentials Vault → Who has access tab.
--
-- Reads were already permitted via credential_assignments_select.
-- INSERTs still go through edge functions (cred-grant-access /
-- cred-send-direct / cred-request-decision) which use service role.
-- DELETEs are not granted.

drop policy if exists credential_assignments_admin_update on public.credential_assignments;
create policy credential_assignments_admin_update on public.credential_assignments
  for update using (
    exists (
      select 1 from public.org_members m
      where m.org_id = credential_assignments.org_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  )
  with check (
    exists (
      select 1 from public.org_members m
      where m.org_id = credential_assignments.org_id
        and m.user_id = auth.uid()
        and m.role in ('owner','admin')
    )
  );

drop policy if exists credential_assignments_super_update on public.credential_assignments;
create policy credential_assignments_super_update on public.credential_assignments
  for update using (public.is_super_admin()) with check (public.is_super_admin());
