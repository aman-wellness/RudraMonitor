-- One-way sync trigger: licenses.license_key is the source of truth for
-- agent enrollment + validation. organizations.license_key is the
-- dashboard-visible mirror; an earlier customer report showed these two
-- columns drifting (org showed key A, licenses row carried key B), which
-- made enroll-agent accept the key the customer copied while
-- validate-license rejected it with "license not found".
--
-- This trigger keeps organizations.license_key automatically aligned with
-- the most-recent active licenses row so the drift can't re-emerge.
CREATE OR REPLACE FUNCTION sync_org_license_key()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.license_key IS NOT NULL THEN
    UPDATE organizations
       SET license_key = NEW.license_key
     WHERE id = NEW.organization_id
       AND (license_key IS DISTINCT FROM NEW.license_key);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_org_license_key ON licenses;
CREATE TRIGGER trg_sync_org_license_key
AFTER INSERT OR UPDATE OF license_key, status ON licenses
FOR EACH ROW EXECUTE FUNCTION sync_org_license_key();
