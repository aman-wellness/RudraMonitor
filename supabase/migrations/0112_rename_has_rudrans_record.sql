-- 0112_rename_has_rudrans_record.sql
-- Brand rebrand: "Rudrans" → "Wellness Extract". Renames the computed alias
-- `has_rudrans_record` to `has_we_record` in v_org_users. Since this is a
-- view-level alias (not a real column), the change is a CREATE OR REPLACE
-- VIEW with the new name — no data migration required.
--
-- Both old and new names are emitted during the transition window so a
-- mismatched frontend deploy doesn't crash. Drop the old alias in a
-- follow-up migration once all clients are on the new build.

create or replace view public.v_org_users as
  select
    'dir:' || du.id::text as row_id,
    du.org_id,
    coalesce(e.full_name, du.display_name, du.upn) as display_name,
    coalesce(e.work_email, du.upn, du.mail) as work_email,
    e.personal_email,
    coalesce(e.designation, du.job_title) as designation,
    e.department_id,
    e.manager_id,
    e.doj,
    case
      when e.status is not null then e.status
      when du.account_enabled = false then 'disabled'
      else 'active'
    end as status,
    du.provider,
    du.account_enabled,
    e.id as employee_id,
    case when du.provider = 'm365'   then du.external_id else e.m365_user_id   end as m365_user_id,
    case when du.provider = 'google' then du.external_id else e.google_user_id end as google_user_id,
    -- Old alias kept during the transition so any cached frontend build still works.
    case when e.id is not null then true else false end as has_rudrans_record,
    coalesce(e.created_at, du.synced_at) as created_at,
    -- New brand alias — frontend now reads this name.
    case when e.id is not null then true else false end as has_we_record
  from public.directory_users du
  left join public.employees e on e.org_id = du.org_id
    and ((du.provider = 'm365'   and e.m365_user_id   = du.external_id)
      or (du.provider = 'google' and e.google_user_id = du.external_id))

  union all

  select
    'emp:' || e.id::text as row_id,
    e.org_id,
    e.full_name as display_name,
    e.work_email,
    e.personal_email,
    e.designation,
    e.department_id,
    e.manager_id,
    e.doj,
    e.status,
    case
      when e.m365_user_id is not null then 'm365'
      when e.google_user_id is not null then 'google'
      else null
    end as provider,
    null::boolean as account_enabled,
    e.id as employee_id,
    e.m365_user_id,
    e.google_user_id,
    true as has_rudrans_record,
    e.created_at,
    true as has_we_record
  from public.employees e
  where not exists (
    select 1 from public.directory_users du
    where du.org_id = e.org_id
      and ((du.provider = 'm365'   and du.external_id = e.m365_user_id)
        or (du.provider = 'google' and du.external_id = e.google_user_id))
  );
