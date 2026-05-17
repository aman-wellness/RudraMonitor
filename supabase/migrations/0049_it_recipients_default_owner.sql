-- 0049_it_recipients_default_owner.sql
-- Stop defaulting the customer's IT-recipients list to Rudrans's own mailbox
-- (itsupport@wellnessextract.com). Each customer should CC their own IT
-- mailbox, not ours.
--
-- 1. Backfill: any org whose IT recipients are still the Rudrans default
--    (and have an owner with an email) → replace with the owner's email.
-- 2. Going forward: a trigger seeds it_recipient_emails with the owner's
--    email on insert (only when the array is left empty).

-- ---- Backfill ----
update public.organizations o
   set it_recipient_emails = array[u.email]::text[]
  from auth.users u
 where u.id = o.owner_user_id
   and u.email is not null
   and 'itsupport@wellnessextract.com' = any(o.it_recipient_emails);

-- ---- Trigger: default to owner's email on insert ----
create or replace function public.organizations_default_it_recipients()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  owner_email text;
begin
  if coalesce(array_length(new.it_recipient_emails, 1), 0) > 0 then
    return new;
  end if;
  if new.owner_user_id is null then
    return new;
  end if;
  select email into owner_email from auth.users where id = new.owner_user_id;
  if owner_email is not null then
    new.it_recipient_emails := array[owner_email];
  end if;
  return new;
end
$$;

drop trigger if exists trg_orgs_default_it_recipients on public.organizations;
create trigger trg_orgs_default_it_recipients
  before insert on public.organizations
  for each row
  execute function public.organizations_default_it_recipients();
