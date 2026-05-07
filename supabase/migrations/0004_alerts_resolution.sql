-- Allow org members to mark alerts as ai_resolved=true / set resolution text from the dashboard.
-- Reads were already covered by the alerts_select policy on the base schema.

drop policy if exists alerts_update on public.alerts;
create policy alerts_update on public.alerts
  for update
  using (agent_id in (select id from public.agents where org_id in (select public.user_org_ids())))
  with check (agent_id in (select id from public.agents where org_id in (select public.user_org_ids())));
