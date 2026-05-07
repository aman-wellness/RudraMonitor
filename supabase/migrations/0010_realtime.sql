-- Enable Supabase realtime on the tables the dashboard subscribes to.
-- The default `supabase_realtime` publication ships empty; clients only receive postgres_changes
-- for tables explicitly added below. Wrapped in a DO so re-running is safe.

do $$
declare
  tbl text;
begin
  for tbl in
    select unnest(array['agents', 'alerts', 'activity_logs'])
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = tbl
    ) then
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    end if;
  end loop;
end;
$$;
