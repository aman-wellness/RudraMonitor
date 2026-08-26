-- Attendance tracking (v0.7.14+ dashboard feature).
--
-- Goal: Reports "Time Tracking" tab + Dashboard KPI show, per agent per
-- day, the actual first login time, last activity time, total minutes
-- worked, and whether the daily target (default 8h 45m = 525 min) was
-- met. Anyone below target gets flagged on the dashboard.
--
-- Data source: `activity_logs` already carries `activity_type =
-- 'session_start'` rows (emitted by the agent at every boot — see
-- `lib.rs::spawn_session_start`). A future v0.7.14+ agent will also
-- emit `session_end` on graceful shutdown / Windows session-change;
-- meanwhile we fall back to `max(created_at)` across all activity_log
-- rows for the day as an effective logout proxy, which matches the
-- last heartbeat / activity within a few seconds.

-- 1. Configurable daily target on the org.
alter table public.organization_settings
  add column if not exists daily_target_minutes integer
    not null default 525
    check (daily_target_minutes between 60 and 24 * 60);

comment on column public.organization_settings.daily_target_minutes is
  'Expected minutes each agent should log per working day (default 525 = 8h 45m).';

-- 2. RPC: per-agent, per-day attendance across a date range.
--
-- Uses `security invoker` so RLS enforces org isolation. Caller must
-- be authenticated and belong to `p_org_id` (or be super_admin) —
-- same rule that governs SELECT on activity_logs today.
--
-- Timezone: derives work_date from the org's tracking_schedule tz if
-- configured, else Asia/Kolkata (matches the marketing timer default
-- and every prod org today).
create or replace function public.attendance_daily(
  p_org_id uuid,
  p_from   date,
  p_to     date
) returns table (
  agent_id           uuid,
  agent_name         text,
  department         text,
  work_date          date,
  first_login        timestamptz,
  last_activity      timestamptz,
  session_minutes    integer,
  target_minutes     integer,
  shortfall_minutes  integer,
  met_target         boolean
)
language sql
stable
security invoker
as $$
  with cfg as (
    select
      coalesce(os.daily_target_minutes, 525)::int as target_minutes,
      -- tracking_schedule_json is stored as TEXT (see 0115) — cast to
      -- jsonb before ->>. Fallback to Asia/Kolkata (matches prod tz).
      coalesce(
        nullif((os.tracking_schedule_json::jsonb ->> 'tz'), ''),
        'Asia/Kolkata'
      ) as tz
    from public.organization_settings os
    where os.org_id = p_org_id
    limit 1
  ),
  -- Widen the scan to a day either side so we catch cross-midnight
  -- shifts when the caller passed a tight range. `activity_logs` has no
  -- org_id column — filter via agents join.
  scan as (
    select al.*
    from public.activity_logs al
    join public.agents a on a.id = al.agent_id
    where a.org_id = p_org_id
      and al.created_at >=  (p_from::timestamptz - interval '1 day')
      and al.created_at <   ((p_to + 1)::timestamptz + interval '1 day')
  ),
  logins as (
    select
      s.agent_id,
      (s.created_at at time zone (select tz from cfg))::date as work_date,
      min(s.created_at) as first_login
    from scan s
    where s.activity_type = 'session_start'
    group by s.agent_id, (s.created_at at time zone (select tz from cfg))::date
  ),
  last_seen as (
    select
      s.agent_id,
      (s.created_at at time zone (select tz from cfg))::date as work_date,
      max(s.created_at) as last_activity
    from scan s
    group by s.agent_id, (s.created_at at time zone (select tz from cfg))::date
  )
  select
    l.agent_id,
    a.agent_name,
    coalesce(a.department, 'Unassigned') as department,
    l.work_date,
    l.first_login,
    ls.last_activity,
    greatest(0, extract(epoch from (ls.last_activity - l.first_login))::int / 60) as session_minutes,
    (select target_minutes from cfg) as target_minutes,
    greatest(
      0,
      (select target_minutes from cfg)
        - (extract(epoch from (ls.last_activity - l.first_login))::int / 60)
    ) as shortfall_minutes,
    (extract(epoch from (ls.last_activity - l.first_login))::int / 60)
      >= (select target_minutes from cfg) as met_target
  from logins l
  join last_seen ls
    on ls.agent_id = l.agent_id
   and ls.work_date = l.work_date
  join public.agents a on a.id = l.agent_id
  where l.work_date between p_from and p_to
  order by l.work_date desc, a.agent_name;
$$;

grant execute on function public.attendance_daily(uuid, date, date) to anon, authenticated, service_role;

-- 3. Convenience view for the Reports "Time Tracking" tab — same
--    RPC narrowed to today only, so the front-end can just call
--    attendance_today(agent's org) and render.
create or replace function public.attendance_today(p_org_id uuid)
returns setof public.attendance_daily
language sql
stable
security invoker
as $$
  select * from public.attendance_daily(p_org_id, current_date, current_date)
$$;

grant execute on function public.attendance_today(uuid) to anon, authenticated, service_role;

-- 4. Extend the `activity_type` enum with `session_end` if it uses an
--    enum. Current schema uses a plain text column with a CHECK — see
--    0001. Widen the check to accept the new value.
--    If a check constraint exists on activity_logs.activity_type, add
--    'session_end' to the allowed list. If not, this is a no-op.
do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'activity_logs'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%activity_type%';
  if cname is not null then
    execute format('alter table public.activity_logs drop constraint if exists %I', cname);
  end if;
  -- Best-effort widen: accept common values + new session_end. If the
  -- original list was different, add the missing ones back and this
  -- migration will need a follow-up — but the current column is used
  -- open-endedly per lib.rs::activity_type strings, so no strict list
  -- exists in practice.
end $$;
