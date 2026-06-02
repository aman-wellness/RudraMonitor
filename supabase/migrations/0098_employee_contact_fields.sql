-- Microsoft 365 "Manage contact information" parity.
--
-- M365 admin center exposes a long contact form per user (office, phones,
-- street/city/state/zip/country, fax). Until now the Rudrans dashboard only
-- collected designation + department + manager — the other fields had to be
-- set by the admin in the M365 portal, then trickled back via directory sync.
--
-- This migration adds the missing fields on BOTH:
--   employees       — Rudrans-side source of truth, used by the edit modal
--                     and pushed to Graph on save.
--   directory_users — read-side mirror updated by directory-sync + the
--                     m365-webhook handler when Graph notifies us of changes
--                     made directly in the M365 portal.
--
-- Manager assignment also gets a Graph push on save (separate edge call —
-- not a column change). directory_users.manager_external_id is added so the
-- sync side can record who Graph says the manager is, for future reverse
-- sync (Graph → employees.manager_id).

BEGIN;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS office_location  text,
  ADD COLUMN IF NOT EXISTS office_phone     text,
  ADD COLUMN IF NOT EXISTS fax_number       text,
  ADD COLUMN IF NOT EXISTS mobile_phone     text,
  ADD COLUMN IF NOT EXISTS street_address   text,
  ADD COLUMN IF NOT EXISTS city             text,
  ADD COLUMN IF NOT EXISTS state_province   text,
  ADD COLUMN IF NOT EXISTS postal_code      text,
  ADD COLUMN IF NOT EXISTS country          text;

ALTER TABLE public.directory_users
  ADD COLUMN IF NOT EXISTS office_location     text,
  ADD COLUMN IF NOT EXISTS office_phone        text,
  ADD COLUMN IF NOT EXISTS fax_number          text,
  ADD COLUMN IF NOT EXISTS mobile_phone        text,
  ADD COLUMN IF NOT EXISTS street_address      text,
  ADD COLUMN IF NOT EXISTS city                text,
  ADD COLUMN IF NOT EXISTS state_province      text,
  ADD COLUMN IF NOT EXISTS postal_code         text,
  ADD COLUMN IF NOT EXISTS country             text,
  ADD COLUMN IF NOT EXISTS manager_external_id text;

COMMIT;
