-- 0154_hardware_assets_inventory_join.sql
--
-- Bridge between the human-maintained IT asset register (hardware_assets)
-- and the agent-collected inventory (agent_inventory). The join key is
-- the SMBIOS chassis serial that agents now ship as
-- agent_inventory.hardware->>'system_serial' — the same string the OEM
-- prints on the sticker and the admin already types into
-- hardware_assets.device_serial.
--
-- Deliverables:
--   1. VIEW  hardware_assets_with_agent  — one row per hardware asset,
--      augmented with the latest agent_inventory row for that serial
--      (agent_id, agent_name, agent_version, summary flags) and the
--      collected_at timestamp. When no agent has ever reported that
--      serial the augment columns are NULL.
--   2. Case-insensitive serial matching. OEMs write serials in mixed
--      case (Dell uppercases, Lenovo mixed); admins type them however
--      they type them. Normalising to upper-trimmed on both sides means
--      "abc123" and "ABC123 " still match.
--
-- Read-only. RLS on hardware_assets already scopes to the caller's org,
-- and a VIEW inherits the underlying table's policies for RLS purposes
-- (security_invoker=on), so the same admin who could see the asset can
-- see its augment.

BEGIN;

CREATE OR REPLACE VIEW public.hardware_assets_with_agent
WITH (security_invoker = on)
AS
WITH latest AS (
    SELECT DISTINCT ON (upper(trim(hardware->>'system_serial')))
        upper(trim(hardware->>'system_serial')) AS norm_serial,
        agent_id,
        collected_at,
        hardware,
        software,
        battery,
        system_events,
        summary
    FROM public.agent_inventory
    WHERE hardware ? 'system_serial'
      AND hardware->>'system_serial' IS NOT NULL
      AND btrim(hardware->>'system_serial') <> ''
    ORDER BY upper(trim(hardware->>'system_serial')),
             collected_at DESC
)
SELECT
    a.*,
    l.agent_id                                        AS matched_agent_id,
    ag.agent_name                                     AS matched_agent_name,
    ag.machine_name                                   AS matched_machine_name,
    ag.agent_version                                  AS matched_agent_version,
    l.collected_at                                    AS inventory_collected_at,
    l.hardware                                        AS inventory_hardware,
    l.software                                        AS inventory_software,
    l.battery                                         AS inventory_battery,
    l.system_events                                   AS inventory_system_events,
    l.summary                                         AS inventory_summary
FROM public.hardware_assets a
LEFT JOIN latest l
       ON upper(trim(a.device_serial)) = l.norm_serial
LEFT JOIN public.agents ag
       ON ag.id = l.agent_id;

COMMENT ON VIEW public.hardware_assets_with_agent IS
  'Hardware register augmented with the latest agent inventory joined by SMBIOS system_serial.';

-- Same idea from the other direction: given an agent, what asset row
-- (and therefore what assigned employee) matches its reported serial?
-- Useful for the agent-detail Inventory tab.
CREATE OR REPLACE VIEW public.agent_inventory_with_asset
WITH (security_invoker = on)
AS
WITH latest AS (
    SELECT DISTINCT ON (agent_id)
        id,
        agent_id,
        org_id,
        hardware,
        software,
        battery,
        system_events,
        summary,
        collected_at
    FROM public.agent_inventory
    ORDER BY agent_id, collected_at DESC
)
SELECT
    l.*,
    a.id                       AS asset_id,
    a.device_serial            AS asset_device_serial,
    a.device_tag               AS asset_device_tag,
    a.device_type              AS asset_device_type,
    a.brand                    AS asset_brand,
    a.model                    AS asset_model,
    a.status                   AS asset_status,
    a.assigned_employee_id     AS asset_assigned_employee_id
FROM latest l
LEFT JOIN public.hardware_assets a
       ON upper(trim(a.device_serial)) = upper(trim(l.hardware->>'system_serial'))
      AND a.org_id = l.org_id;

COMMENT ON VIEW public.agent_inventory_with_asset IS
  'Latest agent inventory per agent, augmented with the matching hardware_assets row.';

COMMIT;
