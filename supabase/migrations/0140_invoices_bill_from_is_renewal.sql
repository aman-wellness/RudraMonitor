-- 0140_invoices_bill_from_is_renewal.sql
--
-- FIX (audit C4, and partially M6).
--
-- `generate_billing_invoice` (migration 0109) inserts into invoices.bill_from
-- and invoices.is_renewal, and the customer Admin Portal selects bill_from —
-- but neither column was ever added to the invoices table (created in 0013).
-- Consequences observed:
--   • After a successful Razorpay charge the RPC throws ("column bill_from does
--     not exist"), so NO invoice row is ever created.
--   • The portal's "Invoice History" query 400s and silently shows "No invoices
--     yet" (the reported admin-portal 400).
--
-- This adds the two missing columns. `bill_from` records who billed the
-- customer ('trackforce' direct, or 'partner' via a reseller); `is_renewal`
-- flags renewal invoices vs. first purchases.

alter table public.invoices
  add column if not exists bill_from  text    not null default 'trackforce',
  add column if not exists is_renewal boolean not null default false;

-- Constrain to the known values (NOT VALID: don't rescan existing rows; the
-- backfill below makes them all conform anyway).
alter table public.invoices
  drop constraint if exists invoices_bill_from_check;
alter table public.invoices
  add constraint invoices_bill_from_check
  check (bill_from in ('trackforce', 'partner')) not valid;

-- Backfill existing rows: an invoice tied to a partner was billed via that
-- partner. This also fixes existing partner-routed customers who were seeing an
-- empty invoice list because their rows weren't tagged 'partner'. (New rows are
-- still tagged by the RPC — see the M6 follow-up in AUDIT_FIX_TRACKER.md to make
-- the RPC itself partner-aware for freshly generated invoices.)
update public.invoices
   set bill_from = 'partner'
 where partner_id is not null
   and bill_from <> 'partner';

create index if not exists invoices_bill_from_idx
  on public.invoices(organization_id, bill_from, issued_at desc);
