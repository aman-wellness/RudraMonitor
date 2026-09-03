-- 0155_tool_runs_shorter_reaper.sql
--
-- Tighten the running→cancelled reaper from 60 min to 25 min.
-- Optimize.ps1 was slimmed down 2026-09-02 (sfc + DISM /RestoreHealth +
-- chkdsk removed — they were repair, not optimization, and legitimately
-- pushed runs past 45 min on modest hardware). Agent RUN_TIMEOUT dropped
-- from 45 min → 20 min in the same release. 25 min gives the retry-
-- wrapped agent-tool-result POST ~5 min of headroom on top of the hard
-- cap before the reaper considers the row abandoned.
--
-- Pending threshold stays 5 min — that's about how long an agent WSS
-- reconnect can take on a bad network before the missed-broadcast row
-- should give up.

BEGIN;

CREATE OR REPLACE FUNCTION public.reap_stale_tool_runs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_cancelled integer;
BEGIN
  WITH reaped AS (
    UPDATE public.tool_runs
    SET    state        = 'cancelled',
           completed_at = now(),
           stdout_tail  = COALESCE(stdout_tail, '') ||
             CASE
               WHEN state = 'pending'
                 THEN E'\n[reaper] agent never acknowledged the tool.run broadcast within 5 min — likely offline or WSS not subscribed at broadcast time.'
               ELSE E'\n[reaper] agent started the run but never posted a completion within 25 min — either the process crashed or the endpoint disappeared.'
             END
    WHERE  (state = 'pending' AND created_at < now() - interval '5 minutes')
       OR  (state = 'running' AND COALESCE(started_at, created_at) < now() - interval '25 minutes')
    RETURNING 1
  )
  SELECT count(*) INTO n_cancelled FROM reaped;
  RETURN n_cancelled;
END;
$$;

COMMIT;
