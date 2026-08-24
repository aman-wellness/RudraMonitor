-- Force `email_intercept_public_only = false` for every org AND lock
-- it there. The v0.7.0-v0.7.10 agents that saw this flag true tried to
-- run the local MITM proxy (127.0.0.1:47443). Every re-enable attempt
-- (v0.7.6 pre-flight, v0.7.9 no_proxy, v0.7.10 dup-install sweep) left
-- some agents stuck: OS proxy set to a listener that had died, so
-- every reqwest call (agent heartbeat + Tauri updater) drained into
-- a dead port and the endpoint went offline.
--
-- Two things this migration does:
--   1. Reset the flag on every existing dlp_settings row.
--   2. Add a CHECK constraint so the toggle can never be true again
--      until we ship a redesigned interception path that does not
--      touch the OS proxy at all.
--
-- v0.7.11+ ignores the flag entirely (spawn_mitm_gate is not called),
-- but a settings-tick that sees `false` on older-but-still-running
-- agents (v0.5.6-v0.7.10) at least prevents the gate from re-firing
-- if the agent process restarts.

update public.dlp_settings
   set email_intercept_public_only = false
 where email_intercept_public_only is distinct from false;

alter table public.dlp_settings
  alter column email_intercept_public_only set default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'dlp_settings_email_intercept_off_check'
  ) then
    alter table public.dlp_settings
      add constraint dlp_settings_email_intercept_off_check
        check (email_intercept_public_only = false);
  end if;
end $$;
