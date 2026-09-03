-- Marketing-website pricing cards (the public /pricing page).
--
-- These are PRESENTATIONAL rows, deliberately separate from public.plans:
-- billing plans are per-cycle / per-seat / Razorpay-tied, while a website
-- card groups monthly+yearly into one tile, can be "Custom pricing"
-- (Enterprise) with no billing row at all, and carries pure-display fields
-- (icon, accent colour, badge, feature bullets, order).
--
-- Managed from the super-admin portal: /admin/plans -> "Website pricing
-- cards" tab. Billing/checkout still runs entirely off public.plans.

create table if not exists public.site_plans (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,                       -- STARTER / PROFESSIONAL / ...
  tagline            text,                                -- short line under the name
  price_monthly      numeric(10,2),                       -- shown when the Monthly toggle is active
  price_yearly       numeric(10,2),                       -- shown when the Yearly toggle is active
  custom_price_label text,                                -- e.g. 'Custom pricing' — overrides the numbers when set
  currency_symbol    text not null default '₹',
  price_note         text not null default '/ user / month',
  features           text[] not null default '{}',        -- one bullet per entry, rendered top-to-bottom
  accent             text not null default '#0D9488',     -- hex colour for icon/checks/CTA
  icon               text not null default 'rocket' check (icon in ('rocket','chart','building')),
  badge              text,                                -- e.g. 'MOST POPULAR' — renders the gradient top banner + highlighted border
  cta_label          text not null default 'Start free trial',
  cta_href           text not null default '/signup',     -- site route (/signup, /contact) or full URL
  display_order      int  not null default 0,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.site_plans enable row level security;

-- The marketing site is unauthenticated — anon must be able to read the
-- active cards. Inactive rows stay hidden from everyone but super-admins.
create policy site_plans_read_public on public.site_plans
  for select using (is_active = true);

create policy site_plans_super_all on public.site_plans
  for all using (public.is_super_admin()) with check (public.is_super_admin());

-- Seed with the three cards currently hardcoded on /pricing, so the page
-- looks identical the moment it switches to DB-driven rendering. Only when
-- empty — re-running the migration must not duplicate or resurrect cards.
insert into public.site_plans
  (name, tagline, price_monthly, price_yearly, custom_price_label, features, accent, icon, badge, cta_label, cta_href, display_order)
select * from (values
  ('Starter', 'For small teams getting started with visibility.', 199.00::numeric, 159.00::numeric, null::text,
   array['Activity & time tracking','App & website usage','Productivity insights','Basic reports'],
   '#0D9488', 'rocket', null::text, 'Start free trial', '/signup', 1),
  ('Professional', 'For teams that need deeper visibility.', 299.00, 239.00, null,
   array['Everything in Starter','Screenshots','Live screen view','Advanced productivity analytics','DLP & security alerts','Advanced reports'],
   '#0D9488', 'chart', 'MOST POPULAR', 'Start free trial', '/signup', 2),
  ('Enterprise', 'For organizations with advanced requirements.', null, null, 'Custom pricing',
   array['Everything in Professional','Advanced DLP','SSO & permissions','Custom data retention','Dedicated support','Custom deployment'],
   '#7C3AED', 'building', null, 'Talk to sales', '/contact', 3)
) as seed(name, tagline, price_monthly, price_yearly, custom_price_label, features, accent, icon, badge, cta_label, cta_href, display_order)
where not exists (select 1 from public.site_plans);
