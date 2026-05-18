-- 0058_storage_screenshot_video_policies.sql
-- Create the storage RLS policies that let signed-URL generation work for
-- the screenshots + videos buckets. Without these, supabase.storage
-- .createSignedUrls returns null for every path and the UI shows the
-- placeholder-image icon instead of the thumbnail.
--
-- Cloud already has these (added via the Supabase dashboard during initial
-- setup). Self-hosted was missing them — this migration backfills.
--
-- File layout is `<org_id>/<agent_id>/<timestamp>.jpg` so the policy gates
-- on the FIRST folder component matching one of the caller's org_ids.

-- Buckets must exist before we attach policies.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('screenshots', 'screenshots', false, 524288,    array['image/jpeg']),
  ('videos',      'videos',      false, 16777216,  array['video/mp4'])
on conflict (id) do nothing;

-- ---- screenshots: read ----
drop policy if exists "screenshots: org members read" on storage.objects;
create policy "screenshots: org members read" on storage.objects
  for select using (
    bucket_id = 'screenshots'
    and (storage.foldername(name))[1]::uuid in (select public.user_org_ids())
  );

-- ---- videos: read ----
drop policy if exists "videos: org members read" on storage.objects;
create policy "videos: org members read" on storage.objects
  for select using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1]::uuid in (select public.user_org_ids())
  );

-- Service-role bypasses RLS, so the upload-screenshot / upload-video edge
-- functions keep working unchanged. No INSERT policy needed.
