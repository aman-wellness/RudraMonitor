-- 0083_invoice_fetch_jobs.sql
-- Job queue for the monthly auto-invoice fetcher. Daily cron enqueues one row
-- per credential whose billing day has passed for the current period and
-- which doesn't yet have an invoice row for that period. Three workers
-- consume from the queue:
--   • Tier 1 — `invoice-sync` edge fn for credentials with a billing API
--     connector (Stripe / Razorpay / future AWS / OpenAI etc.)
--   • Tier 2 — `invoice-inbound` waits for the per-org inbound email address
--     to receive the PDF from the platform
--   • Tier 3 — Playwright + LLM browser agent on EC2 (Phase 2)
-- Whichever tier delivers the invoice first updates the job to `success`.
--
-- Each job carries the canonical billing period so re-enqueueing is idempotent.

create table if not exists public.invoice_fetch_jobs (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  credential_id          uuid not null references public.credentials(id) on delete cascade,

  billing_period_start   date not null,
  billing_period_end     date not null,

  status                 text not null default 'queued'
                           check (status in (
                             'queued','running','success','failed',
                             'needs_otp','needs_otp_timeout','needs_human','cancelled'
                           )),
  tier                   text not null default 'api'
                           check (tier in ('api','email','scrape')),
  attempts               int  not null default 0,
  last_error             text,

  locked_by              text,
  locked_at              timestamptz,

  result_invoice_id      uuid references public.credential_invoices(id) on delete set null,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  completed_at           timestamptz
);

-- One open job per (credential, period). Closed jobs (success / failed /
-- cancelled) don't count so we can retry a later month independently.
create unique index if not exists invoice_fetch_jobs_open_unique
  on public.invoice_fetch_jobs(credential_id, billing_period_start)
  where status in ('queued','running','needs_otp');

create index if not exists invoice_fetch_jobs_org_idx     on public.invoice_fetch_jobs(org_id, created_at desc);
create index if not exists invoice_fetch_jobs_queued_idx  on public.invoice_fetch_jobs(status, created_at) where status = 'queued';
create index if not exists invoice_fetch_jobs_running_idx on public.invoice_fetch_jobs(status, locked_at) where status = 'running';

create or replace function public.touch_invoice_fetch_jobs_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_invoice_fetch_jobs_touch on public.invoice_fetch_jobs;
create trigger trg_invoice_fetch_jobs_touch before update on public.invoice_fetch_jobs
  for each row execute function public.touch_invoice_fetch_jobs_updated_at();

alter table public.invoice_fetch_jobs enable row level security;

drop policy if exists invoice_fetch_jobs_select on public.invoice_fetch_jobs;
create policy invoice_fetch_jobs_select on public.invoice_fetch_jobs
  for select using (org_id in (select public.user_org_ids()));

-- Writes only via service role (edge fns + cron). Members can cancel their
-- own org's queued jobs via an RPC later if needed.

-- ── Credentials: per-row opt-out for auto-fetch ───────────────────────────
-- Default true: every credential with a billing date participates. Customer
-- can disable per-credential from the vault UI (e.g. for one-off purchases
-- that won't recur).
alter table public.credentials
  add column if not exists auto_fetch_enabled boolean not null default true,
  add column if not exists last_fetch_attempt_at timestamptz;

-- Keep in sync with 0079_credentials_estimated_amount.sql (latest pre-existing
-- redefinition) and append the new auto-fetch columns.
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
         created_by, created_at, updated_at, last_rotated_at
    from public.credentials;
alter view public.credentials_safe set (security_invoker = true);
grant select on public.credentials_safe to authenticated;
