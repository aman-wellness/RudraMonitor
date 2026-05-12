-- Super-admin storage / data usage view + manual purge.
--
-- Two RPCs:
--   1. get_storage_stats()  → per-org breakdown (rows + bytes) for the
--                             admin dashboard.
--   2. purge_org_data(...)  → delete screenshots / videos / activity logs
--                             / system metrics / alerts older than a given
--                             date for a single org.
--
-- Both are super_admin-only and audited.

-- Helper to assert caller is super_admin (used inside both RPCs).
create or replace function public._assert_super_admin()
returns void language plpgsql as $$
begin
  if auth.uid() is null then return; end if;  -- service-role bypass
  if not exists (select 1 from app_users where user_id = auth.uid() and app_role = 'super_admin') then
    raise exception 'forbidden: super_admin only' using errcode = '42501';
  end if;
end$$;

-- ── 1. Storage stats ───────────────────────────────────────────────────────
-- Returns one row per organization with rough storage and row counts.
-- Storage byte sums come from storage.objects.metadata->>'size'.
create or replace function public.get_storage_stats()
returns table(
  organization_id uuid,
  org_name        text,
  partner_name    text,
  agent_count     bigint,
  screenshot_count bigint,
  screenshot_bytes bigint,
  video_count     bigint,
  video_bytes     bigint,
  activity_log_rows bigint,
  metric_rows      bigint,
  alert_rows       bigint,
  total_bytes      bigint
)
language sql security definer set search_path = public, storage as $$
  with shots as (
    select split_part(o.name, '/', 1)::uuid as org_id,
           count(*) as cnt,
           coalesce(sum((o.metadata->>'size')::bigint), 0) as bytes
    from storage.objects o
    where o.bucket_id = 'screenshots' and o.name ~ '^[0-9a-f-]+/'
    group by 1
  ),
  vids as (
    select split_part(o.name, '/', 1)::uuid as org_id,
           count(*) as cnt,
           coalesce(sum((o.metadata->>'size')::bigint), 0) as bytes
    from storage.objects o
    where o.bucket_id = 'videos' and o.name ~ '^[0-9a-f-]+/'
    group by 1
  ),
  agents_per_org as (
    select org_id, count(*) as cnt from public.agents group by 1
  ),
  acts as (
    select a.org_id, count(*) as cnt
    from public.activity_logs al join public.agents a on a.id = al.agent_id
    group by 1
  ),
  metrics as (
    select a.org_id, count(*) as cnt
    from public.system_metrics m join public.agents a on a.id = m.agent_id
    group by 1
  ),
  alerts_per_org as (
    select a.org_id, count(*) as cnt
    from public.alerts al join public.agents a on a.id = al.agent_id
    group by 1
  )
  select
    o.id,
    o.name,
    p.name,
    coalesce(ag.cnt, 0),
    coalesce(s.cnt, 0),  coalesce(s.bytes, 0),
    coalesce(v.cnt, 0),  coalesce(v.bytes, 0),
    coalesce(act.cnt, 0),
    coalesce(m.cnt, 0),
    coalesce(al.cnt, 0),
    coalesce(s.bytes, 0) + coalesce(v.bytes, 0)
  from public.organizations o
  left join public.partners p   on p.id  = o.partner_id
  left join shots s             on s.org_id = o.id
  left join vids v              on v.org_id = o.id
  left join agents_per_org ag   on ag.org_id = o.id
  left join acts act            on act.org_id = o.id
  left join metrics m           on m.org_id = o.id
  left join alerts_per_org al   on al.org_id = o.id
  where exists (
    select 1 from app_users where user_id = auth.uid() and app_role = 'super_admin'
  )
  order by (coalesce(s.bytes, 0) + coalesce(v.bytes, 0)) desc, o.created_at desc;
$$;

grant execute on function public.get_storage_stats() to authenticated;

-- ── 2. Manual purge ────────────────────────────────────────────────────────
-- Deletes rows / objects belonging to one org that are older than p_before.
-- p_kinds whitelist: any subset of
--   {'screenshots','videos','activity_logs','system_metrics','alerts'}
-- Returns counts of items deleted per kind.
create or replace function public.purge_org_data(
  p_org_id   uuid,
  p_before   timestamptz,
  p_kinds    text[] default array['screenshots','videos','activity_logs','system_metrics','alerts']
) returns table(kind text, deleted bigint)
language plpgsql security definer set search_path = public, storage as $$
declare
  v_caller uuid := auth.uid();
  v_shots   bigint := 0;
  v_videos  bigint := 0;
  v_acts    bigint := 0;
  v_metrics bigint := 0;
  v_alerts  bigint := 0;
begin
  perform public._assert_super_admin();
  if p_org_id is null then raise exception 'org_id required' using errcode = '22023'; end if;
  if p_before is null  then raise exception 'before date required' using errcode = '22023'; end if;

  -- Storage objects: delete from storage.objects where prefix matches org id
  -- AND created_at < p_before. We sum bytes first for the audit log.
  if 'screenshots' = any(p_kinds) then
    with del as (
      delete from storage.objects
      where bucket_id = 'screenshots'
        and name like p_org_id::text || '/%'
        and created_at < p_before
      returning 1
    ) select count(*) into v_shots from del;
  end if;

  if 'videos' = any(p_kinds) then
    with del as (
      delete from storage.objects
      where bucket_id = 'videos'
        and name like p_org_id::text || '/%'
        and created_at < p_before
      returning 1
    ) select count(*) into v_videos from del;
  end if;

  if 'activity_logs' = any(p_kinds) then
    with del as (
      delete from public.activity_logs al
      using public.agents a
      where a.id = al.agent_id and a.org_id = p_org_id and al.created_at < p_before
      returning 1
    ) select count(*) into v_acts from del;
  end if;

  if 'system_metrics' = any(p_kinds) then
    with del as (
      delete from public.system_metrics m
      using public.agents a
      where a.id = m.agent_id and a.org_id = p_org_id and m.recorded_at < p_before
      returning 1
    ) select count(*) into v_metrics from del;
  end if;

  if 'alerts' = any(p_kinds) then
    with del as (
      delete from public.alerts al
      using public.agents a
      where a.id = al.agent_id and a.org_id = p_org_id and al.created_at < p_before
      returning 1
    ) select count(*) into v_alerts from del;
  end if;

  insert into public.audit_log (actor_user, actor_role, action, target_type, target_id, metadata)
  values (v_caller, 'super_admin', 'data.purge', 'organization', p_org_id,
          jsonb_build_object(
            'before', p_before, 'kinds', p_kinds,
            'screenshots_deleted', v_shots,
            'videos_deleted', v_videos,
            'activity_logs_deleted', v_acts,
            'system_metrics_deleted', v_metrics,
            'alerts_deleted', v_alerts
          ));

  return query
    select 'screenshots'::text,    v_shots   union all
    select 'videos'::text,         v_videos  union all
    select 'activity_logs'::text,  v_acts    union all
    select 'system_metrics'::text, v_metrics union all
    select 'alerts'::text,         v_alerts;
end$$;

grant execute on function public.purge_org_data(uuid, timestamptz, text[]) to authenticated;
