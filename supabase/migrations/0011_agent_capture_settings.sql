-- Per-agent capture settings. Admins toggle these from the dashboard; the agent fetches its own
-- settings every few minutes via the agent-settings Edge Function.

alter table public.agents
  add column if not exists screenshots_enabled boolean not null default true,
  add column if not exists active_window_enabled boolean not null default true,
  add column if not exists screenshot_interval_secs integer not null default 300,
  add column if not exists idle_threshold_secs integer not null default 300;

-- Sanity bounds.
alter table public.agents
  drop constraint if exists agents_capture_intervals_check;
alter table public.agents
  add constraint agents_capture_intervals_check
  check (
    screenshot_interval_secs between 30 and 3600
    and idle_threshold_secs between 60 and 3600
  );
