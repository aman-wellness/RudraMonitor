-- 0037_employee_team_view.sql
-- View that exposes each employee alongside the count of active direct
-- reports (people who currently have manager_id pointing at them). Used by
-- the Managers admin page to surface "who manages whom" without recomputing
-- the counter from the client every time.

create or replace view public.v_employee_with_team_size as
  select
    e.*,
    (
      select count(*)::int
        from public.employees r
       where r.manager_id = e.id
         and r.status <> 'offboarded'
    ) as team_size
  from public.employees e;
