-- Video recording. Agent records short H.264 clips via ffmpeg, uploads to a private bucket,
-- and writes an activity_logs row pointing at the storage path.

-- Per-agent enable + interval. Defaults: disabled (opt-in), 30 min interval, 10s clips.
alter table public.agents
  add column if not exists videos_enabled boolean not null default false,
  add column if not exists video_interval_secs integer not null default 1800;

alter table public.agents
  drop constraint if exists agents_video_interval_check;
alter table public.agents
  add constraint agents_video_interval_check
  check (video_interval_secs between 60 and 14400);

-- Private bucket. 16 MB cap covers a 10s 720p H.264 clip with comfortable headroom.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', false, 16777216, array['video/mp4'])
on conflict (id) do nothing;

-- Org members can SELECT their org's video objects (used by createSignedUrl from the dashboard).
drop policy if exists "videos: org members read" on storage.objects;
create policy "videos: org members read"
  on storage.objects for select
  using (
    bucket_id = 'videos'
    and (storage.foldername(name))[1]::uuid in (select public.user_org_ids())
  );

-- Writes happen only via the upload-video Edge Function with the service role.
