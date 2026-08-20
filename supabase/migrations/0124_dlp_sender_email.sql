-- DLP email-attachment events need the sender's address (the internal
-- mailbox the file was sent FROM) alongside recipient_email (the TO), so the
-- dashboard can show the full "from -> to" of a flagged transfer.
alter table public.dlp_events
  add column if not exists sender_email text;

comment on column public.dlp_events.sender_email is
  'Sender mailbox for email_attachment events (the FROM address). recipient_email holds the TO.';
