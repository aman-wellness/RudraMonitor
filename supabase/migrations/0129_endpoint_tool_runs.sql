-- 0129_endpoint_tool_runs.sql
--
-- Backing store for the Endpoint Tools feature (Feature A of v0.6.23).
--
-- The admin dashboard's per-agent "Run Driver Update" / "Run Windows
-- Optimizer" button POSTs to the `agent-run-tool` edge function, which
-- INSERTs a row here (state='pending') and broadcasts `tool.run` on the
-- `agent:<agent_id>` Realtime channel. The agent picks up the event, runs
-- the bundled PowerShell script, and POSTs back to `agent-tool-result`,
-- which UPDATEs the row through `running` → `succeeded`/`failed`/`timed_out`.
--
-- Result artifacts (InstalledDrivers.csv / Cleanup_Report.txt) go to the
-- private `tool-run-reports` storage bucket at
-- `<agent_id>/<run_id>-<filename>` and the resulting path is stored in
-- `report_path` for the dashboard to sign + serve.

BEGIN;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'tool_run_state') then
    create type public.tool_run_state as enum (
      'pending',    -- inserted by agent-run-tool; agent hasn't ack'd yet
      'running',    -- agent started the script
      'succeeded',  -- exit code 0
      'failed',     -- non-zero exit code or spawn error
      'timed_out',  -- exceeded RUN_TIMEOUT in endpoint_tools.rs (45 min)
      'cancelled'   -- admin cancelled from the dashboard (future)
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'tool_run_kind') then
    create type public.tool_run_kind as enum (
      'driver_updater',
      'windows_optimizer'
    );
  end if;
end $$;

create table if not exists public.tool_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  agent_id      uuid not null references public.agents(id)        on delete cascade,
  tool_kind     public.tool_run_kind  not null,
  state         public.tool_run_state not null default 'pending',
  exit_code     integer,
  duration_ms   integer,
  -- Last ~8 KB of the script's combined stdout+stderr, plus a leading
  -- header when the tool itself couldn't be started (missing module,
  -- bundled path resolution failure). Nullable when the run is still
  -- pending / running.
  stdout_tail   text,
  -- Storage path inside `tool-run-reports` bucket. Signed URLs are minted
  -- by the frontend on demand; we never write the artifact to a public
  -- bucket because it can include machine identifiers (hostname, driver
  -- INF paths, temp file listings).
  report_path   text,
  -- User (owner/admin) who clicked the Run button. NULL only in the
  -- (currently theoretical) service-role automation path.
  triggered_by  uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  completed_at  timestamptz
);

create index if not exists tool_runs_org_idx
  on public.tool_runs(org_id, created_at desc);

create index if not exists tool_runs_agent_idx
  on public.tool_runs(agent_id, created_at desc);

-- Only one active (pending/running) run per agent at a time. Prevents a
-- spammy admin from queueing four Optimizer runs on the same PC.
create unique index if not exists tool_runs_one_active_per_agent
  on public.tool_runs(agent_id)
  where state in ('pending', 'running');

alter table public.tool_runs enable row level security;

-- Members can SELECT their org's runs. Writes go through service-role
-- (the edge functions) — no INSERT/UPDATE/DELETE policies means anon
-- + user-JWT callers get RLS-denied automatically.
drop policy if exists tool_runs_select on public.tool_runs;
create policy tool_runs_select on public.tool_runs
  for select using (public.is_org_member(org_id));

COMMIT;
