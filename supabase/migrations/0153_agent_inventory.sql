-- 0153_agent_inventory.sql
--
-- Per-agent hardware + software inventory + system-event tail. Runtime
-- performance samples continue to live in `system_metrics` (60 s cadence);
-- this table carries the SLOW-CHANGING inventory (hardware model list,
-- installed software, disk SMART status, last-N Windows event log errors,
-- battery health) that we refresh at most once per 24 h.
--
-- Rationale for a separate table:
--   * Payload is 10-200 KB per agent; would balloon system_metrics.
--   * Query pattern is "latest row per agent", not a time series.
--   * The reaper on tool_runs already illustrates that mixing high-cadence
--     metrics with occasional big blobs makes both queries slower.
--
-- One row per (agent_id, collected_at). We keep history so an admin can
-- diff hardware/software week-over-week (surprise new install → alert),
-- but a tiny cron trims to the last 30 rows per agent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_inventory (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    agent_id      uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    -- Hardware inventory: CPU, RAM, disks (model + SMART), GPU, motherboard,
    -- BIOS, network adapters. Object with named sections.
    hardware      jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Installed programs: array of {name, version, publisher, install_date}
    software      jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Battery health: {design_capacity_mwh, full_capacity_mwh, cycle_count,
    -- health_pct, status} — null on desktops.
    battery       jsonb,
    -- Last N system-log critical/error events: [{time, source, event_id,
    -- level, message}]. On Windows we pull from the System channel.
    system_events jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Summary flags precomputed on the agent so the dashboard fleet list
    -- can badge "at-risk" machines without pulling the full row.
    -- {disk_predict_fail: bool, event_error_count_24h: int,
    --  battery_health_low: bool, os_build, agent_version, ...}
    summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
    collected_at  timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_inventory_agent_time_idx
    ON public.agent_inventory (agent_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS agent_inventory_org_idx
    ON public.agent_inventory (org_id);
-- Fast "at-risk fleet" scan for the dashboard's health badge.
CREATE INDEX IF NOT EXISTS agent_inventory_risk_idx
    ON public.agent_inventory USING gin (summary);

-- Trim helper: keep last 30 rows per agent. Called by the reaper cron
-- alongside tool_runs. Idempotent, cheap.
CREATE OR REPLACE FUNCTION public.trim_agent_inventory()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    n_deleted integer;
BEGIN
    WITH ranked AS (
        SELECT id,
               row_number() OVER (PARTITION BY agent_id ORDER BY collected_at DESC) AS rn
        FROM public.agent_inventory
    ), reaped AS (
        DELETE FROM public.agent_inventory
        WHERE id IN (SELECT id FROM ranked WHERE rn > 30)
        RETURNING 1
    )
    SELECT count(*) INTO n_deleted FROM reaped;
    RETURN n_deleted;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('agent_inventory_trim')
          WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agent_inventory_trim');
        PERFORM cron.schedule(
          'agent_inventory_trim',
          '17 3 * * *',
          $cmd$SELECT public.trim_agent_inventory()$cmd$
        );
    END IF;
END$$;

-- RLS. An org owner / admin sees inventory for agents in their org; agents
-- themselves post via the service_role edge function, so agent-side writes
-- don't need a policy here.
ALTER TABLE public.agent_inventory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_inventory_org_read ON public.agent_inventory;
CREATE POLICY agent_inventory_org_read ON public.agent_inventory
    FOR SELECT
    USING (
        org_id IN (
            SELECT om.org_id
            FROM public.org_members om
            WHERE om.user_id = auth.uid()
              AND om.role IN ('owner', 'admin', 'super_admin')
        )
    );

COMMIT;
