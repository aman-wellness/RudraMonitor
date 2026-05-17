-- 0050_directory_setup_info_rpc.sql
-- Expose the non-secret pieces customers need to configure Domain-Wide
-- Delegation (DWD) in Google Admin and Mail.Send grant in Entra:
--   • Google service-account Client ID (numeric — the value the customer
--     pastes into Google Admin → Security → API controls → DWD).
--   • The exact list of scopes our SA needs.
--   • Microsoft app Client ID (the multi-tenant app customer admin consents).
--
-- These are NOT secrets — Google/Microsoft display them on consent screens to
-- the customer anyway. We just stop hiding them behind RLS so the customer's
-- Integrations page can show them up-front instead of after a failed connect
-- attempt.

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
$$;

grant execute on function public.directory_setup_info() to authenticated, anon;

-- Make sure GOOGLE_SA_CLIENT_ID row exists (admin will fill in via /admin/integrations).
insert into public.integrations(key, value, category, label, description, is_secret)
values ('GOOGLE_SA_CLIENT_ID', '', 'employee_management', 'Google service account — Client ID (numeric)',
  'Numeric Client ID of the Google service account — customer admin pastes this into Google Admin → Security → API controls → Domain-wide delegation.',
  false)
on conflict (key) do nothing;
