-- Audit log for Remote Desktop control sessions. One row per dashboard-initiated
-- remote-control attempt. Written by the webrtc-signal edge function the first
-- time an offer arrives whose SDP contains an `m=application` (data channel)
-- section — that's how we differentiate view-only "Live" sessions from
-- "Remote" sessions.
--
-- started_at is set when the agent's answer comes back (the channel is open
-- at the wire level). ended_at + end_reason are filled in by the edge fn on
-- terminal signaling (peer-connection close, heartbeat timeout marker, or an
-- explicit goodbye message from either side).
CREATE TABLE IF NOT EXISTS remote_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       text NOT NULL UNIQUE,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id         uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  controller_user  uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  offered_at       timestamp with time zone NOT NULL DEFAULT now(),
  started_at       timestamp with time zone,
  ended_at         timestamp with time zone,
  end_reason       text
);

CREATE INDEX IF NOT EXISTS remote_sessions_agent_idx
  ON remote_sessions (agent_id, offered_at DESC);
CREATE INDEX IF NOT EXISTS remote_sessions_org_idx
  ON remote_sessions (org_id, offered_at DESC);

ALTER TABLE remote_sessions ENABLE ROW LEVEL SECURITY;

-- Read: org admins + owners can see their org's remote sessions.
-- Writes go exclusively through the edge function (service role).
CREATE POLICY remote_sessions_read_org_admins ON remote_sessions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members om
      WHERE om.org_id = remote_sessions.org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('admin', 'owner')
    )
  );

COMMENT ON TABLE remote_sessions IS
  'Audit log for Remote Desktop control sessions. One row per dashboard-initiated remote-control attempt. Written by the webrtc-signal edge function.';
