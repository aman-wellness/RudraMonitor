-- 0092_email_domain_org_auto_assign.sql
-- When a new user signs up (web or mobile, any auth method — local
-- email/password, Google, Microsoft), we auto-link them to an existing
-- org by matching their email domain. No more "user signed up but has no
-- org" dead-end onboarding.
--
-- An org can claim multiple domains (e.g. acme.com + acme.in + acme-india.com).
-- Public domains (gmail.com, outlook.com, yahoo.com, hotmail.com) are
-- never auto-matched — those users go through the regular org-creation
-- flow as a new tenant.
--
-- Backfill at the bottom: any existing auth.users without an org_members
-- row get auto-assigned if their domain matches.

-- ── Org-side column: list of claimed domains ─────────────────────────────
alter table public.organizations
  add column if not exists email_domains text[] not null default '{}'::text[];

-- Auto-fill from the owner's email on org creation, so an org's first
-- domain is "free". Admin can edit later via /admin or settings.
create or replace function public.organizations_seed_email_domain()
returns trigger language plpgsql security definer as $$
declare
  v_email text;
  v_domain text;
begin
  if coalesce(array_length(new.email_domains, 1), 0) > 0 then return new; end if;
  if new.owner_user_id is null then return new; end if;
  select email into v_email from auth.users where id = new.owner_user_id;
  if v_email is null then return new; end if;
  v_domain := lower(split_part(v_email, '@', 2));
  if v_domain = '' or v_domain in ('gmail.com','outlook.com','yahoo.com','hotmail.com','icloud.com','live.com','protonmail.com') then
    return new;     -- public domain, don't claim
  end if;
  new.email_domains := array[v_domain];
  return new;
end$$;

drop trigger if exists trg_orgs_seed_email_domain on public.organizations;
create trigger trg_orgs_seed_email_domain
  before insert on public.organizations
  for each row execute function public.organizations_seed_email_domain();

-- ── User-side trigger: match domain → insert org_members row ────────────
-- Fires AFTER an auth.users row is inserted, regardless of auth method.
-- Looks up the first org claiming the email domain (oldest org wins for
-- determinism). Inserts a viewer-role membership; admin can promote.

create or replace function public.auth_user_auto_assign_org()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_domain text;
  v_org_id uuid;
begin
  if new.email is null then return new; end if;
  v_domain := lower(split_part(new.email, '@', 2));
  if v_domain = '' or v_domain in ('gmail.com','outlook.com','yahoo.com','hotmail.com','icloud.com','live.com','protonmail.com') then
    return new;     -- public domain → user goes through manual org-creation flow
  end if;

  -- Pick the oldest org claiming this domain (deterministic).
  select id into v_org_id
    from public.organizations
   where v_domain = any(email_domains)
   order by created_at asc
   limit 1;
  if v_org_id is null then return new; end if;

  -- Don't double-insert if already a member.
  if exists (select 1 from public.org_members where user_id = new.id and org_id = v_org_id) then
    return new;
  end if;

  insert into public.org_members (user_id, org_id, role, app_access)
    values (new.id, v_org_id, 'viewer', array['credentials']::text[])
  on conflict do nothing;
  return new;
end$$;

revoke all on function public.auth_user_auto_assign_org() from public, anon, authenticated;

drop trigger if exists trg_auth_user_auto_assign_org on auth.users;
create trigger trg_auth_user_auto_assign_org
  after insert on auth.users
  for each row execute function public.auth_user_auto_assign_org();

-- ── Public RPC: peek at the org a given email would join ────────────────
-- Used by the mobile / web login screens to show "you'll be added to <Org>
-- on signup" reassurance text without requiring the user to be logged in.
-- Returns one row (or none) — never throws.
create or replace function public.org_claim_by_email(p_email text)
returns table(org_id uuid, org_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_domain text;
begin
  if p_email is null or p_email = '' then return; end if;
  v_domain := lower(split_part(p_email, '@', 2));
  if v_domain = '' or v_domain in ('gmail.com','outlook.com','yahoo.com','hotmail.com','icloud.com','live.com','protonmail.com') then
    return;
  end if;
  return query
    select id, name from public.organizations
     where v_domain = any(email_domains)
     order by created_at asc
     limit 1;
end$$;

grant execute on function public.org_claim_by_email(text) to anon, authenticated;

-- ── Backfill existing users without an org membership ────────────────────
do $$
declare
  v_count int := 0;
  u record;
  v_domain text;
  v_org_id uuid;
begin
  for u in
    select id, email from auth.users
     where email is not null
       and not exists (select 1 from public.org_members where user_id = auth.users.id)
  loop
    v_domain := lower(split_part(u.email, '@', 2));
    if v_domain = '' or v_domain in ('gmail.com','outlook.com','yahoo.com','hotmail.com','icloud.com','live.com','protonmail.com') then continue; end if;
    select id into v_org_id from public.organizations
     where v_domain = any(email_domains)
     order by created_at asc limit 1;
    if v_org_id is null then continue; end if;
    insert into public.org_members (user_id, org_id, role, app_access)
      values (u.id, v_org_id, 'viewer', array['credentials']::text[])
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;
  raise notice 'backfilled % memberships', v_count;
end$$;

-- ── Seed: claim the owner's domain on every existing org that has none ──
do $$
declare
  o record;
  v_email text;
  v_domain text;
  v_count int := 0;
begin
  for o in select id, owner_user_id from public.organizations where coalesce(array_length(email_domains, 1), 0) = 0 and owner_user_id is not null loop
    select email into v_email from auth.users where id = o.owner_user_id;
    if v_email is null then continue; end if;
    v_domain := lower(split_part(v_email, '@', 2));
    if v_domain = '' or v_domain in ('gmail.com','outlook.com','yahoo.com','hotmail.com','icloud.com','live.com','protonmail.com') then continue; end if;
    update public.organizations set email_domains = array[v_domain] where id = o.id;
    v_count := v_count + 1;
  end loop;
  raise notice 'seeded domain on % orgs', v_count;
end$$;
