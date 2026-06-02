-- 0027_integrations_m365_google.sql
-- Per-org connections to Microsoft 365 (OAuth + admin consent) and Google
-- Workspace (service account + Domain-Wide Delegation). Plus mirror tables
-- that cache directory state for fast UI; writes always go to the provider
-- first, then update the mirror.

-- ============== org_integrations ==============
-- One row per (org, provider). Holds tokens / tenant identifiers / sync state.
-- Tokens are stored encrypted using pgp_sym_encrypt with a key fetched from
-- the `integrations` table (DIRECTORY_TOKEN_ENC_KEY).
create table if not exists public.org_integrations (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  provider            text not null check (provider in ('m365', 'google')),

  -- M365: tenant_id is the Azure AD directory id. For Google: customer_id (My Customer / Cxxxx).
  tenant_id           text,
  -- Primary verified domain (e.g. "contoso.com") — used to construct UPNs.
  primary_domain      text,
  -- Admin who connected (for audit only; sync uses app-only/SA tokens).
  connected_by_email  text,

  -- For M365: app-only token via client_credentials is preferred (the
  -- customer admin-consents to OUR multi-tenant app); refresh_token is only
  -- needed if we ever do delegated calls. Stored encrypted regardless.
  -- Ciphertext is base64-encoded output of pgp_sym_encrypt; stored as text
  -- for cleaner round-trips through supabase-js (bytea over PostgREST is
  -- awkward — base64 text avoids per-row decode dance).
  refresh_token_enc   text,
  access_token_enc    text,
  access_token_expires_at timestamptz,

  -- For Google: store the impersonation subject (admin email used by the
  -- service account to act as a Workspace super-admin).
  impersonate_subject text,

  scopes              text[] not null default '{}',
  status              text not null default 'pending',   -- pending | active | error | disconnected
  status_detail       text,
  last_sync_at        timestamptz,
  last_sync_error     text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (org_id, provider)
);

create index if not exists org_integrations_org_idx      on public.org_integrations(org_id);
create index if not exists org_integrations_status_idx   on public.org_integrations(status);

create or replace function public.touch_org_integrations_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_org_integrations_touch on public.org_integrations;
create trigger trg_org_integrations_touch before update on public.org_integrations
  for each row execute function public.touch_org_integrations_updated_at();

-- ============== directory_users ==============
-- Mirror of M365/Google directory users for the org. external_id is the
-- provider's stable user id. UPN is the work email / userPrincipalName.
create table if not exists public.directory_users (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  provider        text not null check (provider in ('m365', 'google')),
  external_id     text not null,

  upn             text,
  display_name    text,
  mail            text,
  given_name      text,
  surname         text,
  job_title       text,
  department      text,
  account_enabled boolean,
  is_shared_mailbox boolean not null default false,
  last_signin_at  timestamptz,
  raw             jsonb not null default '{}'::jsonb,

  synced_at       timestamptz not null default now(),
  unique (org_id, provider, external_id)
);

create index if not exists directory_users_org_provider_idx on public.directory_users(org_id, provider);
create index if not exists directory_users_upn_idx          on public.directory_users(org_id, upn);

-- ============== directory_groups ==============
-- Covers M365 Groups, Distribution Lists, Security groups, Teams (a Team is
-- backed by an M365 Group), Shared Mailboxes (carried as users w/ flag, but
-- also surface here if treated like groups), SharePoint sites.
create table if not exists public.directory_groups (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  provider        text not null check (provider in ('m365', 'google')),
  external_id     text not null,

  group_type      text not null,         -- m365_group | security | distribution | team | shared_mailbox | sharepoint_site | google_group
  display_name    text,
  mail            text,
  description     text,
  visibility      text,                  -- Public | Private | HiddenMembership
  is_team         boolean not null default false,
  owners_count    int not null default 0,
  members_count   int not null default 0,
  raw             jsonb not null default '{}'::jsonb,

  synced_at       timestamptz not null default now(),
  unique (org_id, provider, external_id)
);

create index if not exists directory_groups_org_provider_idx on public.directory_groups(org_id, provider);
create index if not exists directory_groups_type_idx         on public.directory_groups(org_id, group_type);

-- ============== directory_group_members ==============
-- One row per (group, user, role). Role is 'member' or 'owner'.
create table if not exists public.directory_group_members (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  group_id          uuid not null references public.directory_groups(id) on delete cascade,
  external_user_id  text not null,
  role              text not null default 'member' check (role in ('member', 'owner')),
  synced_at         timestamptz not null default now(),
  unique (group_id, external_user_id, role)
);

create index if not exists directory_group_members_group_idx on public.directory_group_members(group_id);
create index if not exists directory_group_members_user_idx  on public.directory_group_members(org_id, external_user_id);

-- ============== directory_channels ==============
-- Teams channels — only relevant when the parent group is a Team.
create table if not exists public.directory_channels (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  group_id          uuid not null references public.directory_groups(id) on delete cascade,
  external_id       text not null,

  name              text,
  description       text,
  membership_type   text,                -- standard | private | shared
  raw               jsonb not null default '{}'::jsonb,
  synced_at         timestamptz not null default now(),
  unique (group_id, external_id)
);

create index if not exists directory_channels_group_idx on public.directory_channels(group_id);

-- ============== directory_delta_state ==============
-- Tracks the @odata.deltaLink / nextSyncToken per resource for incremental sync.
create table if not exists public.directory_delta_state (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  provider    text not null check (provider in ('m365', 'google')),
  resource    text not null,         -- users | groups | groupMembers | channels
  delta_link  text,
  updated_at  timestamptz not null default now(),
  unique (org_id, provider, resource)
);

-- ============== RLS ==============
alter table public.org_integrations          enable row level security;
alter table public.directory_users           enable row level security;
alter table public.directory_groups          enable row level security;
alter table public.directory_group_members   enable row level security;
alter table public.directory_channels        enable row level security;
alter table public.directory_delta_state     enable row level security;

-- org_integrations: visible to org members, BUT the encrypted token columns
-- are hidden by a view. For now we expose the table read-only to members,
-- relying on app code never selecting refresh_token_enc / access_token_enc.
drop policy if exists org_integrations_select on public.org_integrations;
create policy org_integrations_select on public.org_integrations
  for select using (org_id in (select public.user_org_ids()));

-- Writes happen exclusively through edge functions (service-role bypasses RLS).

drop policy if exists directory_users_select on public.directory_users;
create policy directory_users_select on public.directory_users
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists directory_groups_select on public.directory_groups;
create policy directory_groups_select on public.directory_groups
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists directory_group_members_select on public.directory_group_members;
create policy directory_group_members_select on public.directory_group_members
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists directory_channels_select on public.directory_channels;
create policy directory_channels_select on public.directory_channels
  for select using (org_id in (select public.user_org_ids()));

-- delta_state is operational only; not exposed to clients.
drop policy if exists directory_delta_state_none on public.directory_delta_state;
create policy directory_delta_state_none on public.directory_delta_state
  for select using (false);

-- ============== Safe view for clients ==============
-- A scrubbed view that hides token bytea columns so even an accidental
-- "select *" from the UI can't leak ciphertext over the wire.
create or replace view public.org_integrations_safe as
  select id, org_id, provider, tenant_id, primary_domain, connected_by_email,
         impersonate_subject, scopes, status, status_detail,
         last_sync_at, last_sync_error, access_token_expires_at,
         created_at, updated_at
    from public.org_integrations;

-- ============== Generic symmetric encryption RPCs ==============
-- Used by edge functions (service-role only) to encrypt/decrypt bytea
-- ciphertexts without leaking the key into the application layer's logs.
-- Bytea round-trips as base64 over the JS client.

create or replace function public.pgp_sym_encrypt_text_to_bytea(p_plain text, p_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden';
  end if;
  return encode(pgp_sym_encrypt(p_plain, p_key), 'base64');
end$$;

create or replace function public.pgp_sym_decrypt_bytea_to_text(p_cipher_b64 text, p_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden';
  end if;
  return pgp_sym_decrypt(decode(p_cipher_b64, 'base64'), p_key);
end$$;

revoke all on function public.pgp_sym_encrypt_text_to_bytea(text, text) from public, anon, authenticated;
revoke all on function public.pgp_sym_decrypt_bytea_to_text(text, text) from public, anon, authenticated;

-- pgcrypto extension provides pgp_sym_encrypt / pgp_sym_decrypt — ensure it.
create extension if not exists "pgcrypto";

-- Seed new keys into the existing integrations table for Google + crypto.
insert into public.integrations (key, value, category, label, description, is_secret) values
  ('GOOGLE_SA_CLIENT_EMAIL',     null, 'directory', 'Google SA Client Email',     'Service account email for Workspace integration',                  false),
  ('GOOGLE_SA_PRIVATE_KEY',      null, 'directory', 'Google SA Private Key',      'PEM private key for the service account (single line, \\n escaped)', true),
  ('GOOGLE_OAUTH_CLIENT_ID',     null, 'directory', 'Google OAuth Client ID',     'For optional per-admin OAuth flow (not required if SA+DWD used)',   false),
  ('GOOGLE_OAUTH_CLIENT_SECRET', null, 'directory', 'Google OAuth Client Secret', 'Secret for the above',                                              true),
  ('DIRECTORY_M365_CLIENT_ID',   null, 'directory', 'M365 App Client ID',         'Multi-tenant Azure AD app registration client ID (Directory features)', false),
  ('DIRECTORY_M365_CLIENT_SECRET',null,'directory', 'M365 App Client Secret',     'Secret value for the multi-tenant app registration',                   true),
  ('DIRECTORY_M365_REDIRECT_URI',null, 'directory', 'M365 OAuth Redirect URI',    'https://ems.wellnessextract.com/employees/integrations/m365/callback',      false),
  ('DIRECTORY_TOKEN_ENC_KEY',    null, 'directory', 'Directory Token Enc Key',    'pgp_sym_encrypt passphrase for org_integrations tokens (>= 32 chars)', true),
  ('CRED_VAULT_ENC_KEY',         null, 'security',  'Credentials Vault Enc Key',  'pgp_sym_encrypt passphrase for the credentials vault (>= 32 chars)',  true)
on conflict (key) do nothing;
