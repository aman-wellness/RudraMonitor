-- AI-driven marketing automation. Generates daily social-media content
-- + 30s short video + weekly 5min long video, all from OpenAI (GPT-4o
-- + DALL-E 3 + TTS) stitched together by the bundled ffmpeg. Super
-- admin reviews drafts in /admin/marketing and downloads approved
-- content for manual posting to LinkedIn / X / Instagram / YouTube.
--
-- Single-tenant for v1: Rudrans markets ITSELF (one global settings
-- row, not per-customer-org). org_id columns are kept on drafts so
-- a future v2 can support per-customer marketing too without a schema
-- change.

BEGIN;

-- 1. Single global settings row. Holds the brand voice, value props
--    customer-attraction target, OpenAI prompt knobs, and the cron
--    schedule. The OpenAI API key itself lives in the edge runtime's
--    environment (Deno.env.get("MARKETING_OPENAI_API_KEY")) — we don't
--    write it to the DB because (a) only super-admin needs it, (b)
--    edge functions on self-hosted Supabase already have access to
--    env vars set on the docker-compose stack.
CREATE TABLE IF NOT EXISTS public.marketing_settings (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- single-row enforcement
  brand_voice     text NOT NULL DEFAULT 'professional, friendly, slightly humorous; not corporate',
  value_props     text[] NOT NULL DEFAULT ARRAY[
    'Employee monitoring with privacy in mind',
    'Live screen + remote desktop in one tool',
    'AI-powered DLP for USB + email exfiltration',
    'Per-seat pricing, no enterprise bloat'
  ]::text[],
  target_audience text NOT NULL DEFAULT 'IT managers + small/medium business owners in India and SE Asia',
  content_style   text NOT NULL DEFAULT 'tutorial-explainer; one big idea per video; minimal text on screen',
  visual_style    text NOT NULL DEFAULT 'flat-design illustrations, brand colors (emerald + dark gray), no people',
  daily_hour_utc  integer NOT NULL DEFAULT 6  CHECK (daily_hour_utc BETWEEN 0 AND 23),
  weekly_day      integer NOT NULL DEFAULT 1  CHECK (weekly_day BETWEEN 0 AND 6), -- 0=Sun
  enabled         boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES auth.users(id)
);

-- Seed the singleton row.
INSERT INTO public.marketing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 2. One row per generated draft. AI cron writes pending rows; super
--    admin flips to approved / rejected / regen_requested via edge fn.
CREATE TABLE IF NOT EXISTS public.marketing_drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- org_id intentionally nullable for v1 (Rudrans marketing itself).
  -- v2 multi-tenant can set this and add an FK.
  org_id        uuid,
  kind          text NOT NULL CHECK (kind IN ('post', 'short_video', 'long_video')),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'regen_requested')),
  trend_source  text,                 -- short summary of the trend the script is built on
  hook_title    text,                 -- attention-grabbing opener for posts / video first frame
  script        text,                 -- narration / post body
  captions      jsonb,                -- { linkedin: "...", x: "...", instagram: "...", facebook: "..." }
  scene_prompts text[],               -- prompts sent to DALL-E 3 (audit trail)
  image_urls    text[],               -- public/signed URLs for each generated PNG
  audio_url     text,                 -- voiceover MP3 URL
  video_url     text,                 -- final assembled MP4 URL
  scheduled_for date,                 -- target publish date (today by default)
  -- Cost telemetry so we can confirm the ~$13/month estimate after a real week.
  openai_cost_usd numeric(8,4),
  generation_meta jsonb,              -- raw OpenAI usage objects + ffmpeg log
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz,
  approved_by   uuid REFERENCES auth.users(id),
  rejected_at   timestamptz,
  rejected_by   uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS marketing_drafts_scheduled_idx
  ON public.marketing_drafts (scheduled_for DESC, kind);
CREATE INDEX IF NOT EXISTS marketing_drafts_status_idx
  ON public.marketing_drafts (status, created_at DESC);

-- 3. Comments per draft — admin team back-and-forth on what to change.
CREATE TABLE IF NOT EXISTS public.marketing_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id   uuid NOT NULL REFERENCES public.marketing_drafts(id) ON DELETE CASCADE,
  author     uuid NOT NULL REFERENCES auth.users(id),
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketing_comments_draft_idx
  ON public.marketing_comments (draft_id, created_at);

-- 4. RLS — super-admin only for v1. Mutations all happen through edge
--    functions running with service_role.
ALTER TABLE public.marketing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_drafts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY marketing_settings_super_read  ON public.marketing_settings
  FOR SELECT USING (public.is_super_admin());
CREATE POLICY marketing_settings_super_write ON public.marketing_settings
  FOR UPDATE USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

CREATE POLICY marketing_drafts_super_read  ON public.marketing_drafts
  FOR SELECT USING (public.is_super_admin());

-- Writes are service-role only (edge functions); explicit block keeps
-- mistakes loud.
CREATE POLICY marketing_drafts_block_insert ON public.marketing_drafts
  FOR INSERT WITH CHECK (false);
CREATE POLICY marketing_drafts_block_update ON public.marketing_drafts
  FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY marketing_drafts_block_delete ON public.marketing_drafts
  FOR DELETE USING (false);

CREATE POLICY marketing_comments_super_read   ON public.marketing_comments
  FOR SELECT USING (public.is_super_admin());
CREATE POLICY marketing_comments_super_insert ON public.marketing_comments
  FOR INSERT WITH CHECK (public.is_super_admin() AND author = auth.uid());

COMMIT;

-- 5. Storage bucket for marketing media. Private — service-role uploads,
--    super-admin reads via signed URLs the edge function mints.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'marketing-media',
  'marketing-media',
  false,
  104857600, -- 100 MB per file (5min mp4 fits comfortably)
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/mp4', 'video/mp4']
)
ON CONFLICT (id) DO NOTHING;
