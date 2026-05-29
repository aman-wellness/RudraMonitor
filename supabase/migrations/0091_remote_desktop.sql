-- Phase-2 Remote Desktop schema.
--
-- Five tables that capture the full session lifecycle for the RustDesk-
-- based remote-control subsystem. ZERO touch on tables used by the
-- existing LiveKit Live Monitoring path (live_view_sessions stays as is).
--
-- Design notes:
--   • All five tables carry org_id directly (not via JOIN) so RLS can be
--     evaluated cheaply and tenant-isolation is visible at the row level.
--   • remote_sessions.state is the source of truth for session lifecycle.
--     Edge functions write transitions; dashboard subscribes to changes
--     via Supabase Realtime to drive the UI.
--   • remote_audit_logs is append-only — never updated, never deleted by
--     application code. Compliance officers can grant a stricter SELECT
--     policy if needed.

BEGIN;

-- The legacy `remote_sessions` table (from the v0.2 WebRTC DataChannel
-- code path) holds audit history we must NOT lose — it's compliance
-- evidence of every prior remote-control session. Rename it out of the
-- way so the Phase-2 RustDesk tables can take the canonical names the
-- spec calls for. The dashboard's old RemoteTab is being retired by
-- this migration anyway; any future read of legacy sessions should
-- query remote_sessions_v1 explicitly.
ALTER TABLE IF EXISTS public.remote_sessions RENAME TO remote_sessions_v1;
-- Indexes follow the table automatically; rename them too so future
-- migrations on the new table don't collide.
ALTER INDEX IF EXISTS remote_sessions_pkey            RENAME TO remote_sessions_v1_pkey;
ALTER INDEX IF EXISTS remote_sessions_agent_idx       RENAME TO remote_sessions_v1_agent_idx;
ALTER INDEX IF EXISTS remote_sessions_org_idx         RENAME TO remote_sessions_v1_org_idx;
ALTER INDEX IF EXISTS remote_sessions_session_id_key  RENAME TO remote_sessions_v1_session_id_key;

-- ============================================================
-- remote_sessions — one row per Remote Desktop session attempt
-- ============================================================
CREATE TABLE public.remote_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- The "device" being controlled. We reference public.agents (not
  -- public.devices) because Phase-1 LiveView spec hasn't renamed the
  -- existing agents table yet. When migration lands, switch FK.
  agent_id          uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  -- The admin user driving the session. NOT NULL even on auto-approval
  -- because someone clicked "Request Remote" in the dashboard.
  viewer_user_id    uuid NOT NULL,
  state             text NOT NULL DEFAULT 'requested'
                    CHECK (state IN (
                      'requested','consent_pending','approved','denied',
                      'publishing','active','ended','failed','expired'
                    )),
  reason            text,                              -- "Helping with Outlook config" etc.
  rustdesk_id       text,                              -- 9-digit RustDesk ID assigned by hbbs
  session_token_jti text,                              -- jti claim of the short-lived JWT (for revocation)
  requested_at      timestamptz NOT NULL DEFAULT now(),
  approved_at       timestamptz,
  started_at        timestamptz,                      -- when first frame arrives
  ended_at          timestamptz,
  bytes_in          bigint NOT NULL DEFAULT 0,        -- agent → viewer
  bytes_out         bigint NOT NULL DEFAULT 0,        -- viewer → agent
  failure_reason    text,
  client_ip         inet,                              -- admin's IP at request time
  client_ua         text,                              -- admin's user agent
  CONSTRAINT remote_sessions_no_neg CHECK (bytes_in >= 0 AND bytes_out >= 0)
);
CREATE INDEX rem_sess_org_time   ON public.remote_sessions(org_id, requested_at DESC);
CREATE INDEX rem_sess_agent      ON public.remote_sessions(agent_id, requested_at DESC);
CREATE INDEX rem_sess_active     ON public.remote_sessions(agent_id, state)
  WHERE state IN ('requested','consent_pending','approved','publishing','active');
CREATE INDEX rem_sess_state      ON public.remote_sessions(org_id, state);

-- ============================================================
-- remote_permissions — per-device + per-org policy
-- ============================================================
-- One row per agent defines whether remote-desktop is allowed at all,
-- whether employee approval is required, and TTL for "Always allow"
-- decisions. NULL agent_id = the org-default row (one per org).
CREATE TABLE public.remote_permissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id          uuid REFERENCES public.agents(id) ON DELETE CASCADE,  -- NULL = org default
  enabled           boolean NOT NULL DEFAULT true,
  require_consent   boolean NOT NULL DEFAULT true,
  consent_ttl_hours int  NOT NULL DEFAULT 0,             -- 0 = consent every time; N = "Always allow" for N hours
  trusted_admins    uuid[],                              -- if non-empty, only these user_ids may request
  trusted_until     timestamptz,                          -- last "Always allow" expires at
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid
);
-- Unique constraint: exactly ONE row per (org, agent), exactly ONE default per org.
CREATE UNIQUE INDEX rem_perms_org_agent_uniq
  ON public.remote_permissions(org_id, agent_id);
CREATE UNIQUE INDEX rem_perms_org_default_uniq
  ON public.remote_permissions(org_id)
  WHERE agent_id IS NULL;
CREATE INDEX rem_perms_org ON public.remote_permissions(org_id);

-- ============================================================
-- remote_recordings — server-side captures of each session
-- ============================================================
CREATE TABLE public.remote_recordings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES public.remote_sessions(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  storage_path    text NOT NULL,                          -- "<org_id>/<session_id>/recording.mp4"
  mime            text NOT NULL DEFAULT 'video/mp4',
  duration_secs   int,
  size_bytes      bigint,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  finalised_at    timestamptz,
  retention_until timestamptz,                            -- compliance auto-delete date
  encrypted       boolean NOT NULL DEFAULT true
);
CREATE INDEX rem_rec_session ON public.remote_recordings(session_id);
CREATE INDEX rem_rec_org     ON public.remote_recordings(org_id, recorded_at DESC);

-- ============================================================
-- remote_transfers — file-transfer audit
-- ============================================================
CREATE TABLE public.remote_transfers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES public.remote_sessions(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('to_agent','from_agent')),
  file_name     text NOT NULL,
  file_size     bigint,
  file_sha256   text,
  initiated_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  status        text NOT NULL DEFAULT 'in_progress'
                CHECK (status IN ('in_progress','completed','failed','cancelled'))
);
CREATE INDEX rem_tx_session ON public.remote_transfers(session_id);
CREATE INDEX rem_tx_org     ON public.remote_transfers(org_id, initiated_at DESC);

-- ============================================================
-- remote_audit_logs — fine-grained event stream for compliance
-- ============================================================
CREATE TABLE public.remote_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid REFERENCES public.remote_sessions(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('admin','agent','system','employee')),
  actor_user_id uuid,
  action        text NOT NULL,             -- 'request_sent','consent_shown','consent_decision',
                                            -- 'session_started','session_ended','input_blocked',
                                            -- 'clipboard_synced','file_transferred',
                                            -- 'recording_started','recording_uploaded'
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rem_audit_session  ON public.remote_audit_logs(session_id);
CREATE INDEX rem_audit_org_time ON public.remote_audit_logs(org_id, created_at DESC);
CREATE INDEX rem_audit_action   ON public.remote_audit_logs(org_id, action);

-- ============================================================
-- RLS — tenant isolation. Writes go through edge functions (service role).
-- ============================================================
ALTER TABLE public.remote_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_permissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_recordings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_transfers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_audit_logs    ENABLE ROW LEVEL SECURITY;

-- Anyone in the org can see session metadata.
CREATE POLICY rem_sess_read   ON public.remote_sessions
  FOR SELECT USING (org_id IN (SELECT public.user_org_ids()));

-- Permissions: org members read; admin/owner write.
CREATE POLICY rem_perms_read  ON public.remote_permissions
  FOR SELECT USING (org_id IN (SELECT public.user_org_ids()));
CREATE POLICY rem_perms_write ON public.remote_permissions
  FOR ALL USING (
    org_id IN (SELECT public.user_org_ids())
    AND EXISTS (SELECT 1 FROM public.org_members
                WHERE user_id = auth.uid()
                  AND org_id = remote_permissions.org_id
                  AND role IN ('owner','admin'))
  );

-- Recordings + transfers + audit: admin/owner read only (compliance-sensitive).
CREATE POLICY rem_rec_read    ON public.remote_recordings
  FOR SELECT USING (
    org_id IN (SELECT public.user_org_ids())
    AND EXISTS (SELECT 1 FROM public.org_members
                WHERE user_id = auth.uid()
                  AND org_id = remote_recordings.org_id
                  AND role IN ('owner','admin'))
  );
CREATE POLICY rem_tx_read     ON public.remote_transfers
  FOR SELECT USING (
    org_id IN (SELECT public.user_org_ids())
    AND EXISTS (SELECT 1 FROM public.org_members
                WHERE user_id = auth.uid()
                  AND org_id = remote_transfers.org_id
                  AND role IN ('owner','admin'))
  );
CREATE POLICY rem_audit_read  ON public.remote_audit_logs
  FOR SELECT USING (
    org_id IN (SELECT public.user_org_ids())
    AND EXISTS (SELECT 1 FROM public.org_members
                WHERE user_id = auth.uid()
                  AND org_id = remote_audit_logs.org_id
                  AND role IN ('owner','admin'))
  );

-- ============================================================
-- Storage bucket for session recordings.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'rustdesk-recordings',
  'rustdesk-recordings',
  false,
  10737418240,                                  -- 10 GB cap per recording
  ARRAY['video/mp4','video/webm']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS rec_storage_read ON storage.objects;
CREATE POLICY rec_storage_read ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'rustdesk-recordings'
    AND (split_part(name, '/', 1))::uuid IN (SELECT public.user_org_ids())
  );

COMMIT;
