-- 0034_vault_seed_cron_jwt.sql
-- Populate the Supabase Vault secret that the directory_sync_tick cron job
-- reads. This holds the project's service-role JWT — the same value that lives
-- in the Edge Functions env as SUPABASE_SERVICE_ROLE_KEY.
--
-- =====================================================================
-- SECURITY (audit C2): the real service-role JWT was PREVIOUSLY HARD-CODED in
-- this file and committed to git. That key grants full, RLS-bypassing access
-- to the entire production database. Because it is already in git history,
-- editing this file does NOT undo the exposure. REQUIRED manual actions:
--   1. ROTATE it now: Dashboard → Settings → API → "Rotate service_role key".
--   2. Update the Edge Functions env SUPABASE_SERVICE_ROLE_KEY to the new key.
--   3. Seed/rotate this Vault secret with the NEW key, OUT OF BAND (never in a
--      committed file):
--        select vault.update_secret(
--          (select id from vault.decrypted_secrets
--             where name = 'directory_sync_service_role_jwt'),
--          '<new-service-role-jwt>'
--        );
--      (or vault.create_secret(...) if it does not exist yet).
--   4. Consider purging the old key from git history (git filter-repo / BFG).
-- The key no longer lives in this file. This migration now only ensures the
-- secret ROW exists with a clearly-invalid placeholder, so a fresh environment
-- does not silently run the cron with a real key baked into source control.
-- =====================================================================

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'directory_sync_service_role_jwt') then
    perform vault.create_secret(
      'REPLACE_ME_set_via_vault.update_secret_out_of_band',
      'directory_sync_service_role_jwt'
    );
  end if;
end$$;
