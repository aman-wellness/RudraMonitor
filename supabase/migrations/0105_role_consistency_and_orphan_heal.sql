-- 0105_role_consistency_and_orphan_heal.sql
--
-- Two related fixes to stop the "invited customer landed on partner portal"
-- bug from re-occurring:
--
--   1. handle_new_user_role: when a user's email matches a partner, only
--      flip them to 'partner' if the partners row is actually ACTIVE. The
--      original SELECT did already filter status='active', but the UPSERT's
--      ON CONFLICT DO UPDATE force-flipped the row even on collisions. Tightened.
--      Also: only insert the partner_members row when matched_partner is non-null
--      (extra defensive — already true via the IF).
--
--   2. Backfill: any existing app_users row stuck in (app_role='partner',
--      partner_id IS NULL) is downgraded to 'customer'. These rows came from
--      historical bugs and trap users on /partner/dashboard after invite-accept.
--
-- A future-facing check function `is_real_partner(user_id)` codifies the
-- correct definition so the frontend and other edge fns can use one truth.

BEGIN;

-- ── 1. Repair existing orphans ───────────────────────────────────────────
UPDATE public.app_users a
   SET app_role = 'customer', partner_id = NULL
 WHERE a.app_role = 'partner'
   AND a.partner_id IS NULL;

-- Also: anyone whose partner_id points at a non-existent or inactive partner
UPDATE public.app_users a
   SET app_role = 'customer', partner_id = NULL
 WHERE a.app_role = 'partner'
   AND a.partner_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.partners p
      WHERE p.id = a.partner_id AND p.status = 'active'
   );

-- ── 2. Rewrite handle_new_user_role to never orphan ─────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  matched_partner uuid;
  matched_member  uuid;
BEGIN
  SELECT id INTO matched_partner
    FROM public.partners
   WHERE lower(contact_email) = lower(new.email)
     AND status = 'active'
   LIMIT 1;

  IF matched_partner IS NOT NULL THEN
    -- True partner match: set role + tie to partner_id.
    INSERT INTO public.app_users (user_id, app_role, partner_id)
    VALUES (new.id, 'partner', matched_partner)
    ON CONFLICT (user_id) DO UPDATE
      SET app_role = 'partner', partner_id = matched_partner;

    SELECT id INTO matched_member
      FROM public.partner_members
     WHERE partner_id = matched_partner AND lower(email) = lower(new.email)
     LIMIT 1;

    IF matched_member IS NOT NULL THEN
      UPDATE public.partner_members
         SET user_id = new.id,
             full_name = COALESCE(full_name,
                                  new.raw_user_meta_data->>'partner_name',
                                  new.raw_user_meta_data->>'full_name')
       WHERE id = matched_member;
    ELSE
      INSERT INTO public.partner_members (partner_id, user_id, role, email, full_name)
      VALUES (matched_partner, new.id, 'admin', new.email,
              COALESCE(new.raw_user_meta_data->>'partner_name',
                       new.raw_user_meta_data->>'full_name'))
      ON CONFLICT (partner_id, user_id) DO NOTHING;
    END IF;
  ELSE
    -- No partner match → ensure a customer row exists. If a stale partner
    -- row is already present (with NULL partner_id), repair it now.
    INSERT INTO public.app_users (user_id, app_role)
    VALUES (new.id, 'customer')
    ON CONFLICT (user_id) DO UPDATE
      SET app_role = CASE
        WHEN app_users.app_role = 'partner' AND app_users.partner_id IS NULL THEN 'customer'
        ELSE app_users.app_role  -- preserve super_admin, valid partner
      END,
      partner_id = CASE
        WHEN app_users.app_role = 'partner' AND app_users.partner_id IS NULL THEN NULL
        ELSE app_users.partner_id
      END;
  END IF;

  RETURN new;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_new_user_role failed: %', sqlerrm;
  RETURN new;
END
$function$;

-- ── 3. Helper for callers that need to verify "real partner" ─────────────
CREATE OR REPLACE FUNCTION public.is_real_partner(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((
    SELECT EXISTS (
      SELECT 1 FROM public.app_users a
        JOIN public.partners p ON p.id = a.partner_id
       WHERE a.user_id = p_user_id
         AND a.app_role = 'partner'
         AND p.status = 'active'
    )
  ), false);
$$;

GRANT EXECUTE ON FUNCTION public.is_real_partner(uuid) TO authenticated, service_role;

COMMIT;
