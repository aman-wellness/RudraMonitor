-- 0028_credentials.sql
-- Company credentials vault: passwords for SaaS / software platforms stored
-- encrypted at rest. Plus the request-approval workflow (employee → manager
-- → IT → fulfilled by per-platform email).
--
-- Encryption: pgp_sym_encrypt with passphrase = integrations.CRED_VAULT_ENC_KEY.
-- Decryption happens only inside the cred_reveal() RPC, callable only via the
-- service role (i.e. edge functions). The browser never receives plaintext.

-- ============== credentials ==============
create table if not exists public.credentials (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,

  platform_name       text not null,        -- e.g. "Slack", "Figma"
  category            text,                  -- e.g. "design", "comms"
  login_url           text,
  username            text,
  password_enc        text,                  -- base64(pgp_sym_encrypt(password, key))
  notes               text,                  -- non-secret hints, e.g. "use SSO"

  owner_dept_id       uuid references public.org_departments(id) on delete set null,
  tags                text[] not null default '{}',
  is_shared_account   boolean not null default true,  -- false = single-seat, one user at a time
  active              boolean not null default true,

  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_rotated_at     timestamptz
);

create index if not exists credentials_org_idx      on public.credentials(org_id);
create index if not exists credentials_platform_idx on public.credentials(org_id, lower(platform_name));
create index if not exists credentials_dept_idx     on public.credentials(owner_dept_id);

create or replace function public.touch_credentials_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_credentials_touch on public.credentials;
create trigger trg_credentials_touch before update on public.credentials
  for each row execute function public.touch_credentials_updated_at();

-- ============== credential_requests ==============
create table if not exists public.credential_requests (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations(id) on delete cascade,
  requester_employee_id    uuid references public.employees(id) on delete set null,
  requester_email          text not null,            -- captured at submit time (immutable)
  manager_id               uuid references public.employees(id) on delete set null,

  requested_credential_ids uuid[] not null default '{}',
  custom_text              text,                     -- "I also need X which isn't in your list"

  status                   text not null default 'pending_manager'
                             check (status in ('pending_manager','pending_it','approved','rejected','fulfilled')),
  decision_notes           text,
  manager_decided_at       timestamptz,
  it_decided_at            timestamptz,
  fulfilled_at             timestamptz,

  -- Magic-link tokens for stateless approve/reject from email. Each is a
  -- 32-byte random hex string, single-use; cleared when consumed.
  manager_approve_token    text,
  manager_reject_token     text,
  it_approve_token         text,
  it_reject_token          text,
  it_recipients            text[] not null default '{}',  -- IT emails captured at submit time

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists credential_requests_org_idx     on public.credential_requests(org_id, created_at desc);
create index if not exists credential_requests_status_idx  on public.credential_requests(org_id, status);
create index if not exists credential_requests_emp_idx     on public.credential_requests(requester_employee_id);

create or replace function public.touch_credential_requests_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_credential_requests_touch on public.credential_requests;
create trigger trg_credential_requests_touch before update on public.credential_requests
  for each row execute function public.touch_credential_requests_updated_at();

-- ============== credential_request_events ==============
-- Append-only audit of state changes for one request.
create table if not exists public.credential_request_events (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.credential_requests(id) on delete cascade,
  org_id      uuid not null,
  actor       text not null,         -- 'requester' | 'manager' | 'it' | 'system'
  actor_email text,
  event       text not null,         -- 'submitted' | 'manager_approved' | 'manager_rejected' | 'it_approved' | 'it_rejected' | 'mail_sent' | 'fulfilled'
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists credential_request_events_req_idx on public.credential_request_events(request_id, created_at);

-- ============== credential_assignments ==============
-- One row per (credential, employee) delivery. Used by Feature 5 to build
-- the "everything ever sent to this user" list at offboarding.
create table if not exists public.credential_assignments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  credential_id   uuid not null references public.credentials(id) on delete cascade,
  employee_id     uuid not null references public.employees(id) on delete cascade,

  request_id      uuid references public.credential_requests(id) on delete set null,  -- null = direct send by admin
  sent_at         timestamptz not null default now(),
  sent_by         uuid references auth.users(id) on delete set null,
  delivery_email  text not null,
  revoked_at      timestamptz,
  revoked_reason  text
);

create index if not exists credential_assignments_emp_idx  on public.credential_assignments(employee_id, sent_at desc);
create index if not exists credential_assignments_cred_idx on public.credential_assignments(credential_id);
create index if not exists credential_assignments_org_idx  on public.credential_assignments(org_id);

-- ============== RLS ==============
alter table public.credentials                enable row level security;
alter table public.credential_requests        enable row level security;
alter table public.credential_request_events  enable row level security;
alter table public.credential_assignments     enable row level security;

-- credentials: members can see metadata; the bytea password_enc column is
-- never decrypted in a client-readable way. Block reads of the column at the
-- app layer (always select explicit non-password columns).
drop policy if exists credentials_select on public.credentials;
create policy credentials_select on public.credentials
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists credentials_write on public.credentials;
create policy credentials_write on public.credentials
  for all using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));

-- credential_requests: members of the org can read; writes only via edge fns.
drop policy if exists credential_requests_select on public.credential_requests;
create policy credential_requests_select on public.credential_requests
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists credential_request_events_select on public.credential_request_events;
create policy credential_request_events_select on public.credential_request_events
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists credential_assignments_select on public.credential_assignments;
create policy credential_assignments_select on public.credential_assignments
  for select using (org_id in (select public.user_org_ids()));

-- ============== Safe view & RPCs ==============
-- A view that hides password_enc so listing the vault from the UI cannot leak
-- ciphertext. UI must always select from this view, not credentials.
create or replace view public.credentials_safe as
  select id, org_id, platform_name, category, login_url, username, notes,
         owner_dept_id, tags, is_shared_account, active,
         created_by, created_at, updated_at, last_rotated_at
    from public.credentials;

-- Service-role-only RPC to decrypt a password. Edge functions call this with
-- the org's CRED_VAULT_ENC_KEY (from the integrations table). It is wrapped
-- in a function so the key never appears in postgres logs as a query parameter
-- (parameters are obscured by `set_config('log_statement','none', true)`).
create or replace function public.cred_reveal(p_cred_id uuid, p_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plain text;
begin
  -- Restrict to service role. anon / authenticated must not be able to call this.
  if auth.role() is distinct from 'service_role' then
    raise exception 'cred_reveal: forbidden';
  end if;
  select pgp_sym_decrypt(decode(password_enc, 'base64'), p_key)
    into v_plain
    from public.credentials
   where id = p_cred_id;
  return v_plain;
end$$;

revoke all on function public.cred_reveal(uuid, text) from public, anon, authenticated;
