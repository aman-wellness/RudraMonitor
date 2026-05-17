-- 0043_credential_invoices.sql
-- Two related additions:
--   1. `subscription_model` on credentials — distinguishes seat-based SaaS
--      (Slack, Figma) from API/usage-based (OpenAI, Anthropic, AWS) so the
--      cost dashboards can summarise them differently (predictable monthly
--      vs. variable-by-demand).
--   2. `credential_invoices` table — every invoice the org has received for
--      a given platform. Populated manually, by CSV import, by API connector
--      (per-platform connectors built later), or by forwarding the invoice
--      email to a dedicated inbox (future). One row per invoice; external_id
--      enforces dedupe per credential.

alter table public.credentials
  add column if not exists subscription_model text,
  add column if not exists billing_api_provider text,           -- 'openai' | 'stripe' | 'razorpay' | ...
  add column if not exists billing_api_token_enc text;          -- base64(pgp_sym_encrypt(token, CRED_VAULT_ENC_KEY))

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'credentials_subscription_model_check') then
    alter table public.credentials
      add constraint credentials_subscription_model_check
      check (subscription_model is null or subscription_model in ('per_seat','api_usage','flat','hybrid'));
  end if;
end$$;

-- Rebuild the safe view so the new fields are visible to the UI. Postgres
-- needs DROP for column shape changes.
drop view if exists public.credentials_safe;
create view public.credentials_safe as
  select id, org_id, platform_name, category, login_url, username, notes,
         owner_dept_id, tags, is_shared_account, active,
         billing_cycle, price_amount, price_currency, seats_total,
         subscription_starts_at, subscription_ends_at,
         subscription_model, billing_api_provider,
         created_by, created_at, updated_at, last_rotated_at
    from public.credentials;

-- ============== credential_invoices ==============
create table if not exists public.credential_invoices (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  credential_id   uuid not null references public.credentials(id) on delete cascade,

  invoice_number  text,                    -- platform's invoice number
  external_id     text,                    -- platform's internal id (used for dedupe)
  issue_date      date,
  period_start    date,
  period_end      date,
  due_date        date,
  amount          numeric(14, 2),
  currency        text,
  status          text not null default 'pending'
                  check (status in ('paid','pending','overdue','failed','refunded','draft')),
  source          text not null default 'manual',   -- manual | csv | api_<provider> | email
  pdf_url         text,
  usage_summary   jsonb,                   -- API-usage breakdown for usage-based plans
  notes           text,
  raw             jsonb,                   -- original payload from API connector
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One invoice per (credential, external_id) so re-syncs don't dupe.
create unique index if not exists credential_invoices_unique_external
  on public.credential_invoices(credential_id, external_id)
  where external_id is not null;

create index if not exists credential_invoices_org_idx        on public.credential_invoices(org_id, issue_date desc);
create index if not exists credential_invoices_credential_idx on public.credential_invoices(credential_id, issue_date desc);
create index if not exists credential_invoices_status_idx     on public.credential_invoices(org_id, status);

create or replace function public.touch_credential_invoices_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

drop trigger if exists trg_credential_invoices_touch on public.credential_invoices;
create trigger trg_credential_invoices_touch before update on public.credential_invoices
  for each row execute function public.touch_credential_invoices_updated_at();

-- RLS
alter table public.credential_invoices enable row level security;

drop policy if exists credential_invoices_select on public.credential_invoices;
create policy credential_invoices_select on public.credential_invoices
  for select using (org_id in (select public.user_org_ids()));

drop policy if exists credential_invoices_write on public.credential_invoices;
create policy credential_invoices_write on public.credential_invoices
  for all using (org_id in (select public.user_org_ids()))
  with check (org_id in (select public.user_org_ids()));

-- Convenience view: invoice rows joined to their parent credential for display.
create or replace view public.v_credential_invoices as
  select
    i.*,
    c.platform_name,
    c.subscription_model,
    c.category,
    c.owner_dept_id
  from public.credential_invoices i
  join public.credentials c on c.id = i.credential_id;
