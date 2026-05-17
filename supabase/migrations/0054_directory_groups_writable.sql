-- 0054_directory_groups_writable.sql
-- Surface whether a directory_group can be edited via Microsoft Graph. Groups
-- synced from on-premises Active Directory, with dynamic membership rules,
-- or role-assigned are READ-ONLY from Graph's perspective — attempting to
-- add/remove members returns 403 Authorization_RequestDenied. We now capture
-- this during directory-sync so the UI can disable the checkbox up-front
-- instead of letting the user discover the failure on Apply.

alter table public.directory_groups
  add column if not exists is_writable boolean not null default true,
  add column if not exists writable_reason text;

comment on column public.directory_groups.is_writable is
  'False when this group cannot be modified via Microsoft Graph — on-prem AD synced, dynamic membership, or role-assigned. The UI surfaces this as a disabled checkbox + "Read-only" hint.';
