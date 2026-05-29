-- Widen the webrtc_signaling.kind check constraint so the LiveKit
-- pivot's start/stop trigger rows can be inserted.
--
-- Background: the LiveKit + WHIP pivot replaces our DIY SDP signaling
-- (offer / answer / ice_candidate) with a two-message protocol —
-- `livekit_start` tells the agent's whip_publisher to begin publishing
-- into the LiveKit room, `livekit_stop` tells it to tear down. SDP and
-- ICE now live entirely inside LiveKit; we only use webrtc_signaling
-- as the cheap long-poll trigger channel.
--
-- The edge function (webrtc-signal/index.ts) was updated to accept the
-- new kinds in v0.2.52's deploy, but the DB CHECK constraint still
-- enforces the original three-kind whitelist — causing every
-- dashboard's signalStart to fail with 500 "violates check constraint".
--
-- Old kinds stay in the allow-list during the dual-stack rollout
-- window so v0.2.51 customers keep working until they auto-update.
-- Block G of the pivot removes them once we're past ≥95% on v0.2.52.

BEGIN;

ALTER TABLE public.webrtc_signaling
  DROP CONSTRAINT IF EXISTS webrtc_signaling_kind_check;

ALTER TABLE public.webrtc_signaling
  ADD CONSTRAINT webrtc_signaling_kind_check
  CHECK (kind = ANY (ARRAY[
    'offer'::text,
    'answer'::text,
    'ice_candidate'::text,
    'livekit_start'::text,
    'livekit_stop'::text
  ]));

COMMIT;
