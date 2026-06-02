-- 0093_invoice_view_left_join.sql
-- v_credential_invoices was a hard JOIN with credentials, so any invoice
-- with credential_id IS NULL (mobile "Unassigned" snaps, or manual
-- uploads where the user didn't pick a platform) was invisible to the
-- Invoices tab in the dashboard.
--
-- Migration 0091 made credential_id nullable but I forgot to widen the
-- view. Switch to LEFT JOIN and you immediately see the unassigned rows.

drop view if exists public.v_credential_invoices;
create view public.v_credential_invoices as
  select
    i.id, i.org_id, i.credential_id,
    i.invoice_number, i.external_id,
    i.issue_date, i.period_start, i.period_end, i.due_date,
    i.amount, i.currency, i.status,
    i.source, i.pdf_url, i.usage_summary, i.notes, i.raw,
    i.created_by, i.created_at, i.updated_at,
    i.attachment_path, i.attachment_mime, i.attachment_name,
    coalesce(c.platform_name, 'Unassigned') as platform_name,
    c.subscription_model,
    c.category,
    c.owner_dept_id
  from public.credential_invoices i
  left join public.credentials c on c.id = i.credential_id;

alter view public.v_credential_invoices set (security_invoker = true);
grant select on public.v_credential_invoices to authenticated;

-- ── Widen storage bucket mime allowlist ──────────────────────────────────
-- Mobile-app users snap from camera (JPEG) but some pick old gallery
-- photos that the OS hands us as HEIC/HEIF or even GIF. Storage layer
-- currently rejects anything not in a tight allowlist → upload fails
-- silently from the mobile app's perspective. Loosen it.
--
-- The browser /admin/integrations "any image format" promise stays
-- — Claude vision will reject HEIC at extract time, but at least the
-- file lands in the bucket and the row is still recoverable.
update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'image/png', 'image/jpeg', 'image/jpg', 'image/webp',
     'image/gif', 'image/heic', 'image/heif',
     'application/octet-stream'      -- some browsers send this for unknown image types
   ]
 where id = 'credential-invoices';
