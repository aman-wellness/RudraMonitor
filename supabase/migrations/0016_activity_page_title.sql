-- 0016_activity_page_title.sql
-- Browser activity needs both the page URL (for analytics) and the tab title
-- (for the human reading the dashboard). Agent extracts both via osascript on
-- macOS / UI Automation on Windows.
--
-- Convention going forward:
--   - url        : the actual https://... address (or empty if extraction failed)
--   - page_title : the tab title (e.g. "GitHub - facebook/react")
--   - application_name : the browser app name (Chrome, Brave, ...)

alter table public.activity_logs
  add column if not exists page_title text;

create index if not exists activity_logs_page_title_idx
  on public.activity_logs (agent_id, created_at desc)
  where activity_type = 'browser';
