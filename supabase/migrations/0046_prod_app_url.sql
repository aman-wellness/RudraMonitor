-- 0046_prod_app_url.sql
-- Restore APP_PUBLIC_URL to the production origin. Migration 0040 had
-- pointed this at http://localhost:3000 for local dev so the email magic
-- links + decision-result redirects landed on the running Vite server.
-- For the live deploy we point it back to app.rudrans.com so customers
-- clicking links from their work mailbox arrive at the hosted UI.

update public.integrations
   set value = 'https://app.rudrans.com'
 where key = 'APP_PUBLIC_URL';
