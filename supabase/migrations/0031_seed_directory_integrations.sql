-- 0031_seed_directory_integrations.sql
-- Make sure the directory + credential-vault integration rows exist with
-- placeholder values so the Admin → Integrations UI has rows to edit.
-- The actual secret values are set ONCE post-deploy via the admin UI (or via
-- supabase secrets) — they are intentionally NOT committed to source control.
--
-- If you're setting up a fresh environment:
--   1. Apply this migration (creates blank rows).
--   2. Visit /admin/integrations as a super-admin.
--   3. Paste the real values for each key from your password manager.
--
-- Keys this migration ensures exist:
--   DIRECTORY_M365_CLIENT_ID         multi-tenant Entra app id
--   DIRECTORY_M365_CLIENT_SECRET     Entra app secret
--   DIRECTORY_TOKEN_ENC_KEY          32-byte hex; encrypts org_integrations tokens
--   CRED_VAULT_ENC_KEY               32-byte hex; encrypts credentials passwords
--   CRED_REQUEST_SIGNING_KEY         HMAC key for credential-request magic links
--   APP_PUBLIC_URL                   where the public credential-request form lives

insert into public.integrations (key, value, category, label, description, is_secret)
values
  ('DIRECTORY_M365_CLIENT_ID',     '', 'employee_management', 'M365 directory app — client id',     'Multi-tenant Entra app id used for directory sync.', false),
  ('DIRECTORY_M365_CLIENT_SECRET', '', 'employee_management', 'M365 directory app — client secret', 'Entra app client secret.', true),
  ('DIRECTORY_TOKEN_ENC_KEY',      '', 'employee_management', 'Directory token encryption key',     '32-byte hex key used to encrypt OAuth tokens at rest.', true),
  ('CRED_VAULT_ENC_KEY',           '', 'employee_management', 'Credential vault encryption key',    '32-byte hex key used to encrypt vault passwords at rest.', true),
  ('CRED_REQUEST_SIGNING_KEY',     '', 'employee_management', 'Credential request HMAC key',        'HMAC key used to sign magic-link tokens in the cred-request flow.', true),
  ('APP_PUBLIC_URL',               'https://ems.wellnessextract.com', 'employee_management', 'Public app URL', 'Origin used to build magic links shipped over email.', false)
on conflict (key) do nothing;
