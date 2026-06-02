-- Multi-style marketing videos + real app screenshot bank.
--
-- Two things the existing marketing pipeline could not do:
--   1. Generate different VIDEO TYPES per cycle — every draft used the
--      same generic Ken Burns + DALL-E slideshow template.
--   2. Show the REAL app — every scene was a synthetic DALL-E image, so
--      videos never actually featured a Rudrans dashboard screenshot.
--
-- generate.py now picks one of several STYLE templates per run
-- (product-tour, problem-solution, feature-spotlight, before-after,
-- compare-vs-competitor, tutorial-walkthrough) and mixes scene types:
-- real app screenshots from this new bucket, DALL-E illustrations,
-- and ffmpeg-generated text cards.

BEGIN;

-- New columns on marketing_drafts so the admin UI can show WHICH style
-- + scene mix the daemon picked, and so a regenerate request can pass
-- a style override.
ALTER TABLE public.marketing_drafts
  ADD COLUMN IF NOT EXISTS style            text,
  ADD COLUMN IF NOT EXISTS scene_types      text[],
  ADD COLUMN IF NOT EXISTS requested_style  text;

-- Existing rows ran on the legacy slideshow-only path. Tag them so the
-- admin UI distinguishes "old style — pre 2026-05" from "new styled" drafts.
UPDATE public.marketing_drafts
SET style = 'slideshow-legacy'
WHERE style IS NULL;

-- New storage bucket for the app-screenshot bank. Private; capture-screens.py
-- uploads via service-role, generate.py mints signed URLs to download the
-- PNGs during video assembly, the dashboard never reads this bucket directly.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'marketing-app-screens',
  'marketing-app-screens',
  false,
  5242880,                                                -- 5 MB cap per screenshot
  ARRAY['image/png', 'image/jpeg', 'application/json']    -- json for the index file
)
ON CONFLICT (id) DO NOTHING;

-- Super-admin can read (dashboard preview, future "browse the bank" UI).
DROP POLICY IF EXISTS marketing_app_screens_super_read ON storage.objects;
CREATE POLICY marketing_app_screens_super_read ON storage.objects
  FOR SELECT
  USING (bucket_id = 'marketing-app-screens' AND public.is_super_admin());

-- Writes are service-role only (capture-screens.py uses SR key, just like
-- generate.py uploads to marketing-media). Block client inserts loudly.
DROP POLICY IF EXISTS marketing_app_screens_block_writes ON storage.objects;
CREATE POLICY marketing_app_screens_block_writes ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id <> 'marketing-app-screens' OR public.is_super_admin());

COMMIT;
