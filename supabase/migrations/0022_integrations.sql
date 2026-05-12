-- Live-editable integration credentials. Edge functions read from this table
-- (with brief in-memory cache) so super_admin can rotate keys / change senders
-- from the dashboard without a redeploy.

create table if not exists public.integrations (
  key         text primary key,
  value       text,
  category    text not null,
  label       text not null,
  description text,
  is_secret   boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

alter table public.integrations enable row level security;

drop policy if exists integrations_super_admin_select on public.integrations;
create policy integrations_super_admin_select on public.integrations
  for select using (
    exists (select 1 from app_users au where au.user_id = auth.uid() and au.app_role = 'super_admin')
  );

drop policy if exists integrations_super_admin_write on public.integrations;
create policy integrations_super_admin_write on public.integrations
  for all using (
    exists (select 1 from app_users au where au.user_id = auth.uid() and au.app_role = 'super_admin')
  ) with check (
    exists (select 1 from app_users au where au.user_id = auth.uid() and au.app_role = 'super_admin')
  );

create or replace function public.touch_integrations_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end$$;

drop trigger if exists trg_integrations_touch on public.integrations;
create trigger trg_integrations_touch before update on public.integrations
  for each row execute function public.touch_integrations_updated_at();

-- Seed the keys we know about. Values stay null/empty — admin fills via UI.
insert into public.integrations (key, value, category, label, description, is_secret) values
  ('MICROSOFT_TENANT_ID',     null, 'email', 'Microsoft Tenant ID',     'Azure AD Directory (tenant) ID',                       false),
  ('MICROSOFT_CLIENT_ID',     null, 'email', 'Microsoft Client ID',     'Azure AD App (client) ID with Mail.Send permission',   false),
  ('MICROSOFT_CLIENT_SECRET', null, 'email', 'Microsoft Client Secret', 'Client secret value for the Azure app',                 true),
  ('AUTH_EMAIL_FROM',         'itsupport@wellnessextract.com', 'email', 'Sender Mailbox', 'Mailbox auth emails are sent from (must be Exchange Online)', false),
  ('OPENAI_API_KEY',          null, 'ai',    'OpenAI API Key',          'Used for AI features (sk-...)',                         true),
  ('ANTHROPIC_API_KEY',       null, 'ai',    'Anthropic API Key',       'Claude API key (sk-ant-...)',                           true),
  ('RAZORPAY_KEY_ID',         null, 'billing','Razorpay Key ID',        'Razorpay public key id (rzp_live_... / rzp_test_...)',  false),
  ('RAZORPAY_KEY_SECRET',     null, 'billing','Razorpay Key Secret',    'Razorpay secret key',                                   true)
on conflict (key) do nothing;
