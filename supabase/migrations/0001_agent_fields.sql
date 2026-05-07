-- Adds admin-configurable fields on agents that are not derived from monitoring data.
alter table public.agents
  add column if not exists department text,
  add column if not exists machine_name text;

-- Backfill machine_name from agent_name where missing (idempotent).
update public.agents set machine_name = agent_name where machine_name is null;
