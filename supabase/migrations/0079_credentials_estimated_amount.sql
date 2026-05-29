-- Adds optional `estimated_amount` column to credentials + surfaces it
-- in credentials_safe (the org-scoped read view the UI uses).
--
-- price_amount is the contracted per-cycle price (e.g. seat × ₹2,000/mo).
-- For usage-based subscriptions (OpenAI / Anthropic / AWS — anywhere
-- billing_cycle drives a recurring bill but the actual spend varies),
-- admins want to capture an EXPECTED amount separately. Reports can
-- then show "budgeted ₹50k, billed ₹47k" instead of a single ambiguous
-- number. NULL means "no estimate provided."

BEGIN;

ALTER TABLE public.credentials
  ADD COLUMN IF NOT EXISTS estimated_amount numeric(12, 2);

COMMENT ON COLUMN public.credentials.estimated_amount IS
  'Expected per-cycle spend for usage-based subscriptions. '
  'Distinct from price_amount, which is the contracted unit price.';

-- credentials_safe view was redefined by 0044_billing_sync_meta. We have
-- to drop+create because Postgres views can''t add columns in place.
-- Re-list every existing column verbatim and append estimated_amount.
DROP VIEW IF EXISTS public.credentials_safe;
CREATE VIEW public.credentials_safe AS
  SELECT id, org_id, platform_name, category, login_url, username, notes,
         owner_dept_id, tags, is_shared_account, active,
         billing_cycle, price_amount, price_currency, seats_total,
         estimated_amount,
         subscription_starts_at, subscription_ends_at,
         subscription_model, billing_api_provider,
         billing_api_last_synced_at, billing_api_last_sync_error,
         (billing_api_token_enc IS NOT NULL) AS billing_api_connected,
         created_by, created_at, updated_at, last_rotated_at
    FROM public.credentials;
ALTER VIEW public.credentials_safe SET (security_invoker = true);
GRANT SELECT ON public.credentials_safe TO authenticated;

COMMIT;
