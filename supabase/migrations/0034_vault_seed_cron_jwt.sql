-- 0034_vault_seed_cron_jwt.sql
-- Populate the Supabase Vault secret that the directory_sync_tick cron job
-- reads. This is the project's service-role JWT — same value that lives in
-- the Edge Functions env as SUPABASE_SERVICE_ROLE_KEY. It only adds it if
-- absent, so re-running the migration is a no-op.
--
-- IMPORTANT: if you ever rotate the service-role JWT (Dashboard → Settings →
-- API → "Rotate"), update the secret with:
--   select vault.update_secret(
--     (select id from vault.decrypted_secrets where name = 'directory_sync_service_role_jwt'),
--     '<new-jwt>'
--   );

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'directory_sync_service_role_jwt') then
    perform vault.create_secret(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0amF6YXhqaHp2cnpocHRycG1kIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODEzNTY5NywiZXhwIjoyMDkzNzExNjk3fQ.BnNlrAXrDhjolAQasTFvZEVvhn3gWNrsMJgnYDFGQ7E',
      'directory_sync_service_role_jwt'
    );
  end if;
end$$;
