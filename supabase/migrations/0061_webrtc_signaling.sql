-- WebRTC signaling state. Tiny table that the webrtc-signal edge function
-- writes to as agents + dashboards exchange SDP offers/answers and ICE
-- candidates during a live-monitoring session. Rows are short-lived (5 min)
-- so the table never grows unboundedly even with many concurrent sessions.
--
-- A "session" is one dashboard browser ↔ one agent. session_id is generated
-- by the dashboard when the user clicks "Live" on an agent card; the agent
-- receives it via its long-poll on the signaling endpoint.
--
-- Message shape is intentionally generic so the same row schema can carry
-- offers, answers, and individual ICE candidates without three tables.
CREATE TABLE IF NOT EXISTS webrtc_signaling (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- direction: 'to_agent' = dashboard → agent, 'to_dashboard' = agent → dashboard
  direction  text NOT NULL CHECK (direction IN ('to_agent', 'to_dashboard')),
  -- kind: 'offer', 'answer', 'ice_candidate'
  kind       text NOT NULL CHECK (kind IN ('offer', 'answer', 'ice_candidate')),
  -- payload: SDP string for offer/answer, ICE candidate JSON for ice_candidate
  payload    jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  -- Auto-expire: rows older than 5 minutes are dead weight. The edge function's
  -- read path filters on this, so we don't need a separate cron; a daily
  -- vacuum handles the cleanup.
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + interval '5 minutes')
);

CREATE INDEX IF NOT EXISTS webrtc_signaling_session_dir_idx
  ON webrtc_signaling (session_id, direction, created_at);
CREATE INDEX IF NOT EXISTS webrtc_signaling_expires_idx
  ON webrtc_signaling (expires_at);

-- Permissive RLS: the edge function uses the service role to read/write,
-- so anon clients never touch this table directly.
ALTER TABLE webrtc_signaling ENABLE ROW LEVEL SECURITY;

-- Periodic cleanup of expired rows. pg_cron isn't installed on the
-- self-hosted Supabase deployment, so the edge function's read path
-- swallows expired rows via the expires_at filter and we rely on a
-- nightly VACUUM to reclaim space. If volume becomes a concern we
-- can add a cron later.
COMMENT ON TABLE webrtc_signaling IS
  'Transient WebRTC signaling state (offer/answer/ICE). Rows expire after 5 minutes; reads filter on expires_at.';
