-- 0040_dev_app_public_url.sql
-- Point APP_PUBLIC_URL at localhost:3000 for local dev so the email magic
-- links + decision-result redirect come back to your running Vite server.
-- Change this back to https://ems.wellnessextract.com (or your prod origin) before
-- going live — or just override it from Admin → Integrations.

update public.integrations
   set value = 'http://localhost:3000'
 where key = 'APP_PUBLIC_URL';
