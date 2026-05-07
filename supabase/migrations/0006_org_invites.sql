-- Org invites: a pending org_members row is created with email + role before the invitee exists.
-- When the invitee accepts the magic link / signs up, an auth.users trigger fills in their user_id.

-- 1. Schema relaxation: user_id may be null while pending.
alter table public.org_members alter column user_id drop not null;
alter table public.org_members add column if not exists email text;

-- Email unique per org to prevent duplicate pending invites.
create unique index if not exists org_members_org_email_uniq
  on public.org_members (org_id, email)
  where email is not null;

-- 2. Trigger: when auth.users gets an email-confirmed row, link any pending invites by email.
create or replace function public.link_pending_org_member()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.email is not null and new.email_confirmed_at is not null then
    update public.org_members
       set user_id = new.id,
           full_name = coalesce(full_name, new.raw_user_meta_data->>'full_name')
     where lower(email) = lower(new.email)
       and user_id is null;
  end if;
  return new;
end;
$$;

drop trigger if exists link_pending_org_member on auth.users;
create trigger link_pending_org_member
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.link_pending_org_member();

-- 3. RLS: pending rows already covered by the existing org-scoped select policy; no policy change needed.
