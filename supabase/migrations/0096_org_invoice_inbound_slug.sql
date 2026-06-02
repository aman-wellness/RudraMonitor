-- Short per-org slug for the inbound invoice email address.
--
-- Until now the address was `inv-<full-org-uuid>@invoices.wellnessextract.com` —
-- 36 chars of UUID is ugly to paste into a SaaS billing-email form and
-- visually intimidating to admins. Replace it with an 8-char base36 slug
-- so the address becomes `inv-ab12cd34@invoices.wellnessextract.com`.
--
-- Back-compat: the two inbound edge functions (invoice-inbound,
-- invoice-inbound-resend) still accept the OLD UUID form so any platform
-- that's already been configured with the long address keeps working.
-- They look up by slug first, fall back to UUID.

BEGIN;

-- 1. Column.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS invoice_inbound_slug text;

-- 2. Backfill any rows without a slug. Loop with retry-on-conflict so
--    collisions on the unique index resolve cleanly (8-char base36 has
--    36^8 ≈ 2.8T combos, but we still belt-and-suspenders).
DO $$
DECLARE
  r record;
  candidate text;
  tries int;
BEGIN
  FOR r IN SELECT id FROM public.organizations WHERE invoice_inbound_slug IS NULL LOOP
    tries := 0;
    LOOP
      tries := tries + 1;
      -- 8 chars from base36 (a-z 0-9). encode(gen_random_bytes,'hex')
      -- gives 0-9a-f only; substr to 8 keeps the address short.
      candidate := substr(encode(gen_random_bytes(8), 'hex'), 1, 8);
      BEGIN
        UPDATE public.organizations SET invoice_inbound_slug = candidate WHERE id = r.id;
        EXIT;  -- success
      EXCEPTION WHEN unique_violation THEN
        IF tries > 10 THEN
          RAISE EXCEPTION 'gave up generating unique slug for org %', r.id;
        END IF;
        -- retry with a fresh candidate
      END;
    END LOOP;
  END LOOP;
END $$;

-- 3. Lock it in: NOT NULL + UNIQUE. Done AFTER backfill so the constraint
--    doesn't fire on the empty default.
ALTER TABLE public.organizations
  ALTER COLUMN invoice_inbound_slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_invoice_inbound_slug_uniq
  ON public.organizations (invoice_inbound_slug);

-- 4. Auto-generate on INSERT so new orgs created via signup / admin invite
--    get a slug without the FE / edge functions having to know to set one.
CREATE OR REPLACE FUNCTION public.organizations_seed_invoice_inbound_slug()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate text;
  tries int := 0;
BEGIN
  IF NEW.invoice_inbound_slug IS NOT NULL THEN
    RETURN NEW;
  END IF;
  LOOP
    tries := tries + 1;
    candidate := substr(encode(gen_random_bytes(8), 'hex'), 1, 8);
    -- Probe for collision; cheap with the unique index above.
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE invoice_inbound_slug = candidate) THEN
      NEW.invoice_inbound_slug := candidate;
      RETURN NEW;
    END IF;
    IF tries > 10 THEN
      RAISE EXCEPTION 'could not generate unique invoice_inbound_slug after 10 tries';
    END IF;
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_orgs_seed_invoice_inbound_slug ON public.organizations;
CREATE TRIGGER trg_orgs_seed_invoice_inbound_slug
  BEFORE INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_seed_invoice_inbound_slug();

COMMIT;
