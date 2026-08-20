-- system_metrics.disk_activity — how BUSY the disk is, as a separate metric from
-- how FULL it is.
--
-- Until now the agent reported one disk number, computed as
--   (total_space - available_space) / total_space
-- i.e. drive capacity used. The dashboard displayed it next to CPU% and
-- Memory%, so a 63%-full drive read as "63% disk load" — the number people
-- compare against Task Manager's "Disk" column, which is I/O utilisation and
-- was showing 1-5% on the same machine at the same moment.
--
-- Rather than redefine the existing column (which would silently reinterpret
-- every historical sample, including any in production), capacity keeps its
-- column and activity gets a new one:
--
--   disk_usage    — % of the drive that is full          → UI "Space used"
--   disk_activity — % of time the disk was busy with I/O → UI "Disk"
--
-- Nullable on purpose. It stays NULL for:
--   • samples written before this migration
--   • agents older than the build that started reporting it
--   • platforms where the agent cannot measure it (currently non-Windows)
-- The UI renders NULL as "—" rather than 0, so a missing measurement never
-- looks like an idle disk.

ALTER TABLE public.system_metrics
  ADD COLUMN IF NOT EXISTS disk_activity integer;

-- NOT VALID on purpose. A plain ADD CONSTRAINT makes Postgres verify every
-- existing row, taking ACCESS EXCLUSIVE on the table for the whole scan —
-- system_metrics grows by one row per agent per minute, so on a real fleet that
-- blocks metrics ingestion for as long as the scan takes.
--
-- The scan buys nothing here: the column is added by the statement above, so
-- every pre-existing row is unambiguously NULL and NULL already satisfies the
-- check. NOT VALID still enforces the constraint on all new INSERTs and
-- UPDATEs, which is the only thing we need. Run
--   ALTER TABLE public.system_metrics VALIDATE CONSTRAINT
--     system_metrics_disk_activity_range;
-- in a maintenance window if you ever want it marked validated; it takes a
-- weaker SHARE UPDATE EXCLUSIVE lock and does not block writes.
ALTER TABLE public.system_metrics
  DROP CONSTRAINT IF EXISTS system_metrics_disk_activity_range;
ALTER TABLE public.system_metrics
  ADD CONSTRAINT system_metrics_disk_activity_range
  CHECK (disk_activity IS NULL OR (disk_activity >= 0 AND disk_activity <= 100))
  NOT VALID;

COMMENT ON COLUMN public.system_metrics.disk_activity IS
  'Percent of the sampling interval the physical disk was busy with I/O — the '
  'same quantity Task Manager shows in its "Disk" column. NULL when the agent '
  'did not or could not measure it. Distinct from disk_usage, which is how full '
  'the drive is.';

COMMENT ON COLUMN public.system_metrics.disk_usage IS
  'Percent of the drive that is full: (total_space - available_space) / '
  'total_space. NOT I/O activity — see disk_activity for that.';

NOTIFY pgrst, 'reload schema';
