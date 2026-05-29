-- Credential-invoice attachments (PDF / PNG / JPG).
--
-- Customers store every SaaS bill in the Invoices tab — until now there
-- was only `pdf_url` (free-form URL pointing somewhere outside our
-- system). That doesn't work when the source is a screenshot or an
-- email-attached PDF the user wants to drag-drop into the dashboard.
--
-- We add:
--   • A dedicated storage bucket `credential-invoices` (private; signed
--     URLs only — keys are sensitive even though they're not credential
--     secrets per se).
--   • storage.objects RLS so any authenticated org member can
--     read / write under `<org_id>/<credential_id>/...` and nowhere
--     else.
--   • Three columns on credential_invoices for the attached file
--     metadata so the dashboard can render the right preview without
--     a second round-trip.
--
-- Multiple files per invoice aren't supported yet — one attachment per
-- row keeps the UI simple and matches how most SaaS platforms emit
-- one PDF per invoice. Re-upload replaces the existing file.

BEGIN;

-- Attachment metadata. `attachment_path` is the bucket object key
-- (relative to bucket root), so the dashboard can mint a signed URL
-- on demand. `attachment_mime` decides preview vs download. `name` is
-- the original filename for the download link.
ALTER TABLE public.credential_invoices
  ADD COLUMN IF NOT EXISTS attachment_path text,
  ADD COLUMN IF NOT EXISTS attachment_mime text,
  ADD COLUMN IF NOT EXISTS attachment_name text;

COMMENT ON COLUMN public.credential_invoices.attachment_path IS
  'Object key under storage bucket `credential-invoices`. Format: '
  '<org_id>/<credential_id>/<uuid>.<ext>. NULL when only an external '
  'URL (pdf_url) is recorded.';

-- Bucket. Private (signed URLs only). 25 MB upload cap covers every
-- legit PDF / receipt photo. allowed_mime_types is enforced at upload
-- time by storage-api, so the dashboard can rely on it rather than
-- re-validating server-side.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'credential-invoices',
  'credential-invoices',
  false,
  25 * 1024 * 1024,
  ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types,
    public = EXCLUDED.public;

-- RLS on storage.objects scoped to this bucket. Path convention is
-- `<org_id>/<credential_id>/...` — the first folder must be an org
-- the caller belongs to (public.user_org_ids() returns the caller's
-- orgs). storage-api parses path with split_part(name, '/', N).
DROP POLICY IF EXISTS cred_invoice_select ON storage.objects;
CREATE POLICY cred_invoice_select ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'credential-invoices'
    AND (split_part(name, '/', 1))::uuid IN (SELECT public.user_org_ids())
  );

DROP POLICY IF EXISTS cred_invoice_insert ON storage.objects;
CREATE POLICY cred_invoice_insert ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'credential-invoices'
    AND (split_part(name, '/', 1))::uuid IN (SELECT public.user_org_ids())
  );

DROP POLICY IF EXISTS cred_invoice_update ON storage.objects;
CREATE POLICY cred_invoice_update ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'credential-invoices'
    AND (split_part(name, '/', 1))::uuid IN (SELECT public.user_org_ids())
  );

DROP POLICY IF EXISTS cred_invoice_delete ON storage.objects;
CREATE POLICY cred_invoice_delete ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'credential-invoices'
    AND (split_part(name, '/', 1))::uuid IN (SELECT public.user_org_ids())
  );

-- Re-create the view to expose the new columns (drop required because
-- the SELECT list shape changed).
DROP VIEW IF EXISTS public.v_credential_invoices;
CREATE VIEW public.v_credential_invoices AS
  SELECT
    i.*,
    c.platform_name,
    c.subscription_model,
    c.category,
    c.owner_dept_id
  FROM public.credential_invoices i
  JOIN public.credentials c ON c.id = i.credential_id;

COMMIT;
