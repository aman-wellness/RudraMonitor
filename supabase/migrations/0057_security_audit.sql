-- 0057_security_audit.sql
-- Expand the audit trail and add lightweight anomaly tracking. The goal is to
-- have a single queryable record of "interesting" actions per org so we can:
--   • show admins a unified activity feed
--   • spot brute-force / credential-stuffing patterns
--   • give support a paper trail when a customer says "I never did that"
--
-- Most write-paths run through edge functions today; those still call
-- audit_log directly with their own helpful detail. This migration just makes
-- sure the table + indexes exist and adds a per-IP failed-attempt counter.

-- audit_log already exists from migration 0013 with columns:
--   id (bigint), actor_user, actor_role, action, target_type, target_id,
--   metadata (jsonb), created_at
-- We add the columns we need for security-event tracking — additive only,
-- nothing destructive to existing rows.
alter table public.audit_log
  add column if not exists actor_email text,
  add column if not exists ip_address  inet,
  add column if not exists org_id      uuid references public.organizations(id) on delete cascade;

create index if not exists audit_log_org_idx     on public.audit_log(org_id, created_at desc);
create index if not exists audit_log_action_idx  on public.audit_log(action, created_at desc);
create index if not exists audit_log_ip_idx      on public.audit_log(ip_address, created_at desc)
  where action in ('login_failed', 'permission_denied');

alter table public.audit_log enable row level security;

drop policy if exists audit_log_super_read on public.audit_log;
create policy audit_log_super_read on public.audit_log
  for select using (
    exists (select 1 from app_users a where a.user_id = auth.uid() and a.app_role = 'super_admin')
  );

-- Service-role writes only (edge functions). No INSERT/UPDATE policy on
-- purpose — anything that mutates this table must run with service-role.

-- ---- Anomaly: failed-login counter ----
-- A SECURITY DEFINER helper edge functions call after a failed sign-in. We
-- aggregate per-email + per-IP over the last 15 min; > 10 failures locks the
-- account via banned_until for 30 min. The auth UI surfaces "Try again in N
-- minutes" instead of "Wrong password" so timing attacks don't leak.
create or replace function public.record_failed_login(p_email text, p_ip inet)
returns table(locked boolean, attempts_15m int)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_count int;
  v_user_id uuid;
begin
  insert into public.audit_log(action, actor_email, ip_address, metadata)
  values ('login_failed', p_email, p_ip, jsonb_build_object('reason', 'invalid_credentials'));

  select count(*) into v_count
    from public.audit_log
   where action = 'login_failed'
     and (actor_email = p_email or ip_address = p_ip)
     and created_at > now() - interval '15 minutes';

  if v_count >= 10 then
    select id into v_user_id from auth.users where email = p_email;
    if v_user_id is not null then
      update auth.users
         set banned_until = now() + interval '30 minutes'
       where id = v_user_id;
      insert into public.audit_log(action, actor_email, ip_address, metadata)
      values ('account_locked', p_email, p_ip,
              jsonb_build_object('reason', 'brute_force_lockout', 'until', now() + interval '30 minutes'));
    end if;
    return query select true as locked, v_count as attempts_15m;
  else
    return query select false as locked, v_count as attempts_15m;
  end if;
end
$$;

grant execute on function public.record_failed_login(text, inet) to anon, authenticated;
