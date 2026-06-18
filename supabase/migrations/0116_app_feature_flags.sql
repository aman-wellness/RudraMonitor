-- 0116_app_feature_flags.sql
--
-- Global feature flags managed by super-admins. Used to hide entire
-- app features (sidebar items + their routes) until we're ready to
-- ship them. Per-org overrides are NOT modeled here — these are
-- product-level switches, not licensing/billing gates (those already
-- live in plans.features_included / org_effective_features).
--
-- Initial seed disables `auto_invoice` and `otp_channels` — they're
-- half-built, hidden behind sidebar links right now, and we don't
-- want customers stumbling onto them. Super admin flips them on
-- when they're ready.

CREATE TABLE IF NOT EXISTS public.app_features (
  code         text PRIMARY KEY,
  display_name text NOT NULL,
  description  text,
  enabled      boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Trigger to keep updated_at honest.
CREATE OR REPLACE FUNCTION public.app_features_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_features_touch ON public.app_features;
CREATE TRIGGER trg_app_features_touch
  BEFORE UPDATE ON public.app_features
  FOR EACH ROW EXECUTE FUNCTION public.app_features_touch_updated_at();

ALTER TABLE public.app_features ENABLE ROW LEVEL SECURITY;

-- Reads: everyone (the sidebar's gating decision must be available
-- pre-login, since which menu items render is computed in the client).
DROP POLICY IF EXISTS app_features_read ON public.app_features;
CREATE POLICY app_features_read ON public.app_features
  FOR SELECT TO authenticated, anon USING (true);

-- Writes: super admins only. The existing app_users.app_role = 'super_admin'
-- pattern is used (same gate as integrations / pending_signups RLS).
DROP POLICY IF EXISTS app_features_write_super ON public.app_features;
CREATE POLICY app_features_write_super ON public.app_features
  FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = auth.uid() AND au.app_role = 'super_admin')
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.app_users au WHERE au.user_id = auth.uid() AND au.app_role = 'super_admin')
  );

GRANT SELECT ON public.app_features TO authenticated, anon;
GRANT UPDATE (enabled) ON public.app_features TO authenticated;

-- Seed initial features. ON CONFLICT DO NOTHING so re-running the
-- migration doesn't overwrite a super-admin's manual flag flip.
INSERT INTO public.app_features (code, display_name, description, enabled) VALUES
  ('auto_invoice',  'Auto-Invoice',  'Automated invoice generation flow for the credentials vault. Hidden until production-ready.', false),
  ('otp_channels',  'OTP Channels',  'Configurable OTP delivery channels (email, SMS, WhatsApp) for credential-request flows. Hidden until production-ready.', false)
ON CONFLICT (code) DO NOTHING;
