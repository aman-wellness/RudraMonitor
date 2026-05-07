-- Private storage bucket for screenshots. Path scheme: <org_id>/<agent_id>/<unix_ts>.jpg
-- 512 KB cap per file (agent encodes low-quality JPEG).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('screenshots', 'screenshots', false, 524288, array['image/jpeg'])
on conflict (id) do nothing;

-- Org members can SELECT screenshot objects for their orgs (used by createSignedUrl from the dashboard).
drop policy if exists "screenshots: org members read" on storage.objects;
create policy "screenshots: org members read"
  on storage.objects for select
  using (
    bucket_id = 'screenshots'
    and (storage.foldername(name))[1]::uuid in (select public.user_org_ids())
  );

-- Writes happen only via the upload-screenshot Edge Function with the service role, so no INSERT policy is needed.
