-- Storage RLS for the marketing-media bucket. Super-admin reads via
-- signed URLs (the dashboard's /admin/marketing page mints them
-- client-side using the user JWT). Writes are service-role only
-- (the EC2 generate.py uploads with the service key).

BEGIN;

DROP POLICY IF EXISTS marketing_media_super_read ON storage.objects;
CREATE POLICY marketing_media_super_read ON storage.objects
  FOR SELECT
  USING (bucket_id = 'marketing-media' AND public.is_super_admin());

-- Explicit deny on client writes — they all go through generate.py
-- with the service role.
DROP POLICY IF EXISTS marketing_media_block_writes ON storage.objects;
CREATE POLICY marketing_media_block_writes ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id <> 'marketing-media' OR public.is_super_admin());

COMMIT;
