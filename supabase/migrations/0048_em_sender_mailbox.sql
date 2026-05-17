-- 0048_em_sender_mailbox.sql
-- Let each customer pick the mailbox we send Employee-Management emails FROM
-- (credential requests, decision results, public forms). Sender lives in the
-- customer's own M365 tenant so the recipient sees a familiar domain instead
-- of "itsupport@wellnessextract.com".
--
-- Implementation: graph-email.ts mints a Graph token for THIS org's tenant
-- (org_integrations.tenant_id) and POSTs to /users/{em_sender_email}/sendMail.
-- Falls back to the global Rudrans mailbox when em_sender_email is empty OR
-- M365 isn't connected for the org.
--
-- For this to actually deliver, the customer must also grant Mail.Send
-- (application permission) when re-running admin consent.

alter table public.organizations
  add column if not exists em_sender_email        text,
  add column if not exists em_sender_display_name text;

comment on column public.organizations.em_sender_email is
  'Mailbox in the customer''s M365 tenant we should send Employee Management emails from (e.g. hr@customer.com). Empty = fall back to global Rudrans mailbox.';
comment on column public.organizations.em_sender_display_name is
  'Optional display name shown alongside em_sender_email (e.g. "Acme HR").';
