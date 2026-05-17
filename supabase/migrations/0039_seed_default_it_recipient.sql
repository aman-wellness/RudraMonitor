-- 0039_seed_default_it_recipient.sql
-- One-off seed: for any organization that doesn't yet have IT recipients
-- configured, default them to itsupport@wellnessextract.com — same mailbox
-- the auth-email hook uses as the sender. Admins can override anytime via
-- Credentials → Requests → IT recipients → Edit. Idempotent: only touches
-- rows where the array is empty.

update public.organizations
   set it_recipient_emails = array['itsupport@wellnessextract.com']
 where coalesce(array_length(it_recipient_emails, 1), 0) = 0;
