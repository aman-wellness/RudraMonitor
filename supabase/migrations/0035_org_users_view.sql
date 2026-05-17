-- 0035_org_users_view.sql
-- Unified "Users" view for the Employees screen. Combines:
--   • directory_users (every user that exists in the customer's M365 / Google
--     tenant — pulled by directory-sync), and
--   • employees (Rudrans-side rows with HR metadata: department, manager,
--     designation, DOJ, lifecycle status).
--
-- Each directory user is left-joined to its matching employees row (matched
-- by external_id ↔ m365_user_id / google_user_id). Employees rows that have
-- no matching directory user (Rudrans-only / never-synced / orphan) are
-- added via a UNION so they still appear in the list.
--
-- The view is read-only and RLS-scoped via the underlying tables' policies.

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
    case when e.id is not null then true else false end as has_rudrans_record,
    coalesce(e.created_at, du.synced_at) as created_at
  from public.directory_users du
  left join public.employees e on e.org_id = du.org_id
    and ((du.provider = 'm365'   and e.m365_user_id   = du.external_id)
      or (du.provider = 'google' and e.google_user_id = du.external_id))

  union all

  -- Employees with no matching cloud directory row (created via Rudrans but
  -- not yet seen by sync, or imported manually, or cloud user was deleted).
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
    e.created_at
  from public.employees e
  where not exists (
    select 1 from public.directory_users du
    where du.org_id = e.org_id
      and ((du.provider = 'm365'   and du.external_id = e.m365_user_id)
        or (du.provider = 'google' and du.external_id = e.google_user_id))
  );
