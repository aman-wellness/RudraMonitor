-- Widen public.webrtc_signaling.kind to accept the Remote-path relay setup
-- messages. Dashboard's relayClient.ts::postRelaySignal POSTs kind='relay_start'
-- / 'relay_stop' at the beginning and end of every Remote session; without
-- these entries the CHECK constraint rejected the insert, the edge function
-- returned 500 with "violates check constraint webrtc_signaling_kind_check",
-- and the ICE pair on the direct Remote path collapsed ~5 s after connect.
-- Applied out-of-band on prod on 2026-08-27; this migration is the record.

ALTER TABLE public.webrtc_signaling
  DROP CONSTRAINT IF EXISTS webrtc_signaling_kind_check;

ALTER TABLE public.webrtc_signaling
  ADD CONSTRAINT webrtc_signaling_kind_check
  CHECK (kind = ANY (ARRAY[
    'offer'::text,
    'answer'::text,
    'ice_candidate'::text,
    'livekit_start'::text,
    'livekit_stop'::text,
    'relay_start'::text,
    'relay_stop'::text
  ]));
