-- 0113_oauth_mobile_handoff.sql
-- Temp store for Capacitor mobile OAuth flow. The mobile app can't rely on
-- custom-scheme deep links from external browsers (HeyTapBrowser etc.
-- drop the URI data when bouncing back to an already-running app), so the
-- HTTPS bridge page deposits the one-shot PKCE code here keyed by the
-- OAuth `state` param, and the mobile app polls for it on resume.
--
-- The PKCE code is one-shot and expires server-side in ~60 seconds, so
-- keeping the row around forever is harmless — but we trim aggressively
-- to avoid an unbounded table.

create table if not exists public.oauth_mobile_handoff (
  state         text primary key,
  code          text not null,
  created_at    timestamptz not null default now()
);

create index if not exists oauth_mobile_handoff_created_at_idx
  on public.oauth_mobile_handoff (created_at);

-- RLS disabled — only ever accessed via service-role keys from the two
-- edge functions (deposit + retrieve). Anon/JWT users have no business
-- reading raw OAuth codes.
alter table public.oauth_mobile_handoff enable row level security;

-- Periodic cleanup: rows older than 5 minutes are useless (PKCE codes
-- have already expired upstream). Runs every 2 minutes via pg_cron.
do $$
begin
  perform cron.schedule(
    'oauth-mobile-handoff-cleanup',
    '*/2 * * * *',
    $cleanup$delete from public.oauth_mobile_handoff where created_at < now() - interval '5 minutes'$cleanup$
  );
exception when others then
  -- Idempotent: ignore "job already scheduled" errors on re-run.
  null;
end$$;
