-- Microsoft Graph Change Notifications (real-time directory sync).
--
-- Replaces "customer clicks Sync now → full directory walk" with:
--   1. On connect, we POST /v1.0/subscriptions to Graph asking it to push
--      change events to https://api-ems.wellnessextract.com/functions/v1/m365-webhook
--      for the org's /users and /groups resources.
--   2. Graph POSTs notifications whenever a user/group is created, updated,
--      or deleted. Latency: 1-5 sec.
--   3. Our webhook handler does an incremental upsert of THAT row only
--      (one GET to /users/<id> or /groups/<id>) — no full walk.
--   4. Subscriptions expire (max 4230 min for users/groups) so we renew
--      every 12h via the rudrans-m365-renew systemd timer on EC2.
--
-- This migration just adds the bookkeeping columns. The renewal cron +
-- webhook handler + subscribe edge function ship alongside.

BEGIN;

ALTER TABLE public.org_integrations
  ADD COLUMN IF NOT EXISTS subscription_id_users   text,
  ADD COLUMN IF NOT EXISTS subscription_id_groups  text,
  ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz,
  -- Random secret per-org. Microsoft echoes this back in `clientState` on
  -- every notification; we verify before trusting the payload. Generated
  -- on first subscribe; rotated when the customer reconnects.
  ADD COLUMN IF NOT EXISTS webhook_secret          text;

-- Index for the renewal cron — "give me every active integration whose
-- subscription expires within 12 hours".
CREATE INDEX IF NOT EXISTS org_integrations_renewal_idx
  ON public.org_integrations (provider, subscription_expires_at)
  WHERE subscription_id_users IS NOT NULL OR subscription_id_groups IS NOT NULL;

-- Notification → incremental sync work queue. The webhook receiver inserts
-- one row per resource change; a worker (or the webhook itself when fast)
-- consumes the queue and fetches+upserts the changed row.
--
-- Why a queue instead of doing the upsert inline in the webhook?
--   - Graph batches multiple changes into one notification
--   - If our Graph fetch takes >3s, MS retries — duplicate work
--   - The queue gives us idempotency (resource_url is unique-per-attempt)
--     plus a place for retry-with-backoff on transient Graph failures
CREATE TABLE IF NOT EXISTS public.directory_change_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('m365', 'google')),
  -- Graph resource URL, e.g. "users/abc123" or "groups/xyz789" or "groups/xyz789/members"
  resource        text NOT NULL,
  change_type     text NOT NULL CHECK (change_type IN ('created', 'updated', 'deleted')),
  -- Processing state.
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS directory_change_queue_pending_idx
  ON public.directory_change_queue (org_id, created_at)
  WHERE status = 'pending';

ALTER TABLE public.directory_change_queue ENABLE ROW LEVEL SECURITY;

-- Org members can SEE their org's queue (for the Integrations page to show
-- "live updates in flight" if we want to later). Writes are service-role
-- only — the webhook + worker both run with SR key.
DROP POLICY IF EXISTS directory_change_queue_select ON public.directory_change_queue;
CREATE POLICY directory_change_queue_select ON public.directory_change_queue
  FOR SELECT USING (org_id IN (SELECT public.user_org_ids()));

COMMIT;
