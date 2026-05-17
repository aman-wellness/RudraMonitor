-- 0038_credential_request_manager_picks.sql
-- A requester can now pick one or more managers on the public form (the
-- previous flow auto-resolved a single manager from employees.manager_id).
-- We store the picked emails on the request so admins can audit who was
-- routed to. The approval email goes to all picked managers (TO); any one
-- of them clicking the magic link approves the request — the single-use
-- manager_approve_token still wins for the first click.

alter table public.credential_requests
  add column if not exists manager_emails_picked text[] not null default '{}';
