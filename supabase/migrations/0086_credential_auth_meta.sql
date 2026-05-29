-- 0086_credential_auth_meta.sql
-- Phase-2 of the auto-invoice fetcher. Adds the per-credential auth/OTP
-- metadata the browser-agent worker needs:
--
--   • totp_secret_enc       — encrypted Authenticator shared secret. When set,
--                             the worker generates the 6-digit code itself
--                             via otplib and skips the OTP-relay round-trip.
--   • session_cookies_enc   — encrypted cookie jar dumped after a successful
--                             login. Next run loads it back into Playwright,
--                             usually skipping the OTP screen entirely
--                             (sessions are valid 30-90 days on most SaaS).
--   • otp_primary_channel   — preferred OTP delivery: 'totp' | 'magic_link'
--                             | 'dashboard' | 'email_relay' | (Phase-3:
--                             'teams' | 'slack' | 'google_chat' | 'whatsapp')
--   • otp_fallback_channels — ordered list of channels to try if primary
--                             times out after 60 s.
--   • otp_admin_user_ids    — which org users should be paged when the
--                             worker needs an OTP. Defaults to org owner.
--
-- Plus the `otp_requests` table — one row per pending OTP request. The
-- magic-link page and dashboard banner both read & write here; webhook
-- inbound (Teams/Slack/etc) lands here in Phase 3.
--
-- credentials_safe is rebuilt so the UI sees the new columns as booleans
-- (has_totp, has_session) — never raw ciphertext.

create extension if not exists pgcrypto with schema public;

-- ── credentials: new columns ─────────────────────────────────────────────
alter table public.credentials
  add column if not exists totp_secret_enc        text,
  add column if not exists session_cookies_enc    text,
  add column if not exists otp_primary_channel    text not null default 'magic_link'
    check (otp_primary_channel in (
      'totp','magic_link','dashboard','email_relay',
      'teams','slack','google_chat','whatsapp','sms_manual'
    )),
  add column if not exists otp_fallback_channels  text[] not null default array['dashboard','magic_link']::text[],
  add column if not exists otp_admin_user_ids     uuid[] not null default array[]::uuid[];

-- ── credentials_safe: rebuild with booleans (never raw secrets) ──────────
drop view if exists public.credentials_safe;
create view public.credentials_safe as
  select id, org_id, platform_name, category, login_url, username, notes,
         owner_dept_id, tags, is_shared_account, active,
         billing_cycle, price_amount, price_currency, seats_total,
         estimated_amount,
         subscription_starts_at, subscription_ends_at,
         subscription_model, billing_api_provider,
         billing_api_last_synced_at, billing_api_last_sync_error,
         (billing_api_token_enc is not null) as billing_api_connected,
         auto_fetch_enabled, last_fetch_attempt_at,
         (totp_secret_enc is not null) as has_totp,
         (session_cookies_enc is not null) as has_session,
         otp_primary_channel, otp_fallback_channels, otp_admin_user_ids,
         created_by, created_at, updated_at, last_rotated_at
    from public.credentials;
alter view public.credentials_safe set (security_invoker = true);
grant select on public.credentials_safe to authenticated;

-- ── otp_requests: pending OTP prompts from the browser worker ────────────
create table if not exists public.otp_requests (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  credential_id      uuid not null references public.credentials(id) on delete cascade,
  job_id             uuid not null references public.invoice_fetch_jobs(id) on delete cascade,

  prompt             text not null,                       -- shown to admin: "AWS asking for 6-digit code"
  status             text not null default 'pending'
                       check (status in ('pending','fulfilled','expired','cancelled')),

  magic_token_hash   text not null,                       -- sha256 hex; raw token only in the magic link
  channels_sent      text[] not null default array[]::text[],

  response           text,                                -- the OTP code the admin supplied
  responded_by       uuid references auth.users(id) on delete set null,
  responded_via      text,                                -- 'magic_link' | 'dashboard' | 'teams' | …

  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  fulfilled_at       timestamptz
);

create index if not exists otp_requests_job_idx     on public.otp_requests(job_id);
create index if not exists otp_requests_pending_idx on public.otp_requests(org_id, status) where status = 'pending';
create unique index if not exists otp_requests_token_idx on public.otp_requests(magic_token_hash);

alter table public.otp_requests enable row level security;

-- Org members can see pending requests (so the dashboard banner can render
-- in real-time via Supabase Realtime).
drop policy if exists otp_requests_select on public.otp_requests;
create policy otp_requests_select on public.otp_requests
  for select using (org_id in (select public.user_org_ids()));

-- Writes only via service role (edge fns). Magic-link page also uses service
-- role under the hood after verifying the token hash.

-- Realtime: subscribe to inserts/updates so dashboard banner pops instantly.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'otp_requests'
  ) then
    alter publication supabase_realtime add table public.otp_requests;
  end if;
end$$;

-- ── Helper: lazy expire ──────────────────────────────────────────────────
-- Called whenever an edge fn looks at a request, in case the cron hasn't
-- woken up yet. Cheap idempotent UPDATE.
create or replace function public.otp_requests_expire_stale()
returns void
language sql
security definer
set search_path = public
as $$
  update public.otp_requests
     set status = 'expired'
   where status = 'pending'
     and expires_at < now();
$$;

revoke all on function public.otp_requests_expire_stale() from public, anon, authenticated;
