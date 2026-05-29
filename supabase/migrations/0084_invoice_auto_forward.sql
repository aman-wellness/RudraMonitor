-- 0084_invoice_auto_forward.sql
-- After a new credential_invoices row lands (from email forwarder, API
-- sync, or browser-agent scrape), fire `invoice-forward-accounts` via
-- pg_net so the org's accounts_recipient_emails get the PDF / summary.
--
-- Pre-reqs: migration 0030 (organizations.accounts_recipient_emails),
-- migration 0082 (credential-invoices bucket + attachment_path column),
-- and the vault secret `directory_sync_service_role_jwt` already used by
-- migration 0033's directory_sync_tick. Reuses the same JWT.

create extension if not exists pg_net with schema extensions;

alter table public.credential_invoices
  add column if not exists forwarded_at  timestamptz,
  add column if not exists forwarded_to  text[];

create or replace function public.invoice_after_insert_forward()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_jwt text;
  v_url text;
begin
  -- Skip silently if Vault isn't configured (lets dev/local migrations apply
  -- without a secret). Production must call vault.create_secret() once.
  select decrypted_secret into v_jwt
    from vault.decrypted_secrets
   where name = 'directory_sync_service_role_jwt'
   limit 1;
  if v_jwt is null then return new; end if;

  v_url := 'http://kong:8000/functions/v1/invoice-forward-accounts';

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_jwt,
      'Content-Type', 'application/json'
    )::jsonb,
    body := jsonb_build_object('invoice_id', new.id)
  );
  return new;
end$$;

drop trigger if exists trg_credential_invoices_forward on public.credential_invoices;
create trigger trg_credential_invoices_forward
  after insert on public.credential_invoices
  for each row execute function public.invoice_after_insert_forward();
