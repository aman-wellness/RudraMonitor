-- agents.agent_version — the column four code paths already depend on, but
-- which no migration ever created.
--
-- Found while enrolling a real desktop agent against a clean database: every
-- fresh enrolment failed with
--
--   PGRST204: Could not find the 'agent_version' column of 'agents'
--
-- because enroll-agent INSERTs it. The seeded demo agents were inserted
-- directly into the table, bypassing the edge function, which is why this went
-- unnoticed — the very first real enrolment hits it.
--
-- Writers/readers that already assume the column exists:
--   • functions/enroll-agent  — INSERT on first enrol (500s without it)
--   • functions/enroll-agent  — UPDATE on idempotent re-enrol (500s without it)
--   • functions/ingest        — UPDATE on heartbeat when the agent reports a
--                               version, so telemetry would fail too
--   • src/lib/useAgentDetail  — renders it as the "version" chip on the agent
--                               detail header
--
-- Nullable with no default: the value is whatever the agent reports about
-- itself, and "unknown" is a legitimate state for an older agent that doesn't
-- send one. useAgentDetail already renders NULL as "—".

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS agent_version text;

COMMENT ON COLUMN public.agents.agent_version IS
  'Self-reported agent build version (e.g. "0.6.22"). Set on enrol and '
  'refreshed by the ingest heartbeat so the dashboard reflects auto-updates '
  'without a re-enrol. NULL when the agent has never reported one.';

-- PostgREST caches the schema; without this the edge functions keep returning
-- PGRST204 until the container restarts.
NOTIFY pgrst, 'reload schema';
