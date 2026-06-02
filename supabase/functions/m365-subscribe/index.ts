// POST /functions/v1/m365-subscribe
//
// Creates (or renews) Microsoft Graph Change Notification subscriptions
// for an org's M365 integration, pointing them at m365-webhook.
//
// Two modes:
//   A) POST with body { org_id } and user JWT (or service-role bearer) —
//      subscribe THIS one org. Called by oauth-m365-callback right after
//      the customer finishes connecting, and by Integrations → "Sync
//      now" / "Reconnect notifications" buttons.
//   B) POST with body { renew_all: true } and the service-role bearer —
//      renewal cron path. Iterates every active M365 integration whose
//      subscription_expires_at is within 12 hours and extends it.
//
// Behaviour:
//   - If a subscription already exists for the org and hasn't expired,
//     we PATCH it (extend the expirationDateTime).
//   - If no subscription, or it's gone past expiry, we DELETE the old one
//     (best-effort) and POST a fresh one.
//   - Subscriptions are created for `/users` and `/groups` separately;
//     /groups notifications also cover membership changes (Graph delivers
//     an "updated" event on the group when members are added/removed).
//
// Graph subscription limits (as of 2026):
//   /users  : max 4230 minutes ≈ 70.5 h
//   /groups : max 4230 minutes ≈ 70.5 h
// We use 60 hours so renewals at 12h cadence always succeed even when one
// run is missed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { graphTokenFor } from "../_shared/graph.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const GRAPH_BASE       = "https://graph.microsoft.com/v1.0";

// Microsoft Graph rejects any notificationUrl that isn't HTTPS, so we
// can't use the internal `http://kong:8000` SUPABASE_URL — that's what
// SUPABASE_URL points at inside the docker network. Override with the
// public HTTPS endpoint. Configurable via PUBLIC_FUNCTIONS_BASE_URL env
// for non-prod or rename cases.
const PUBLIC_BASE = (Deno.env.get("PUBLIC_FUNCTIONS_BASE_URL") || "https://api-ems.wellnessextract.com").replace(/\/$/, "");
const WEBHOOK_URL = `${PUBLIC_BASE}/functions/v1/m365-webhook`;

// 60 hours — well inside Graph's 70.5h cap for /users + /groups, and long
// enough that even if the renewal cron misses two cycles (24h) the
// subscription stays alive.
const SUBSCRIPTION_LIFETIME_MS = 60 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) return json({ error: "unauthenticated" }, 401);
  const isServiceRole = bearer === SERVICE_ROLE_KEY;

  let body: { org_id?: string; renew_all?: boolean };
  try { body = await req.json(); } catch { body = {}; }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Mode B — renewal cron. Service role only.
  if (body.renew_all) {
    if (!isServiceRole) return json({ error: "renew_all requires service-role bearer" }, 403);
    return await renewAll(admin);
  }

  // Mode A — single org. Either service-role (called by oauth-callback)
  // or a user JWT whose org_members entry includes the requested org.
  if (!body.org_id) return json({ error: "org_id required" }, 400);
  if (!isServiceRole) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return json({ error: "invalid token" }, 401);
    const { data: member } = await admin
      .from("org_members").select("role")
      .eq("user_id", u.user.id).eq("org_id", body.org_id)
      .in("role", ["owner", "admin"])
      .maybeSingle();
    if (!member) return json({ error: "not an owner/admin of this org" }, 403);
  }
  const result = await subscribeOne(admin, body.org_id);
  return json(result, result.ok ? 200 : 500);
});

async function renewAll(admin: ReturnType<typeof createClient>) {
  // Pick rows whose subscription is missing OR expiring within 12 hours.
  const cutoff = new Date(Date.now() + 12 * 3600_000).toISOString();
  const { data: rows } = await admin
    .from("org_integrations")
    .select("org_id, subscription_expires_at, subscription_id_users, subscription_id_groups")
    .eq("provider", "m365")
    .eq("status", "active")
    .or(`subscription_expires_at.is.null,subscription_expires_at.lt.${cutoff}`);
  const results: Array<{ org_id: string; ok: boolean; note?: string }> = [];
  for (const r of (rows ?? []) as Array<{ org_id: string }>) {
    try {
      const out = await subscribeOne(admin, r.org_id);
      results.push({ org_id: r.org_id, ok: out.ok, note: out.note });
    } catch (e) {
      results.push({ org_id: r.org_id, ok: false, note: (e as Error).message.slice(0, 200) });
    }
  }
  return json({ ok: true, processed: results.length, results }, 200);
}

async function subscribeOne(
  admin: ReturnType<typeof createClient>,
  orgId: string,
): Promise<{ ok: boolean; note?: string; users?: string; groups?: string; expires_at?: string }> {
  // Make sure the org actually has an active M365 connection first.
  const { data: row } = await admin
    .from("org_integrations")
    .select("status, webhook_secret, subscription_id_users, subscription_id_groups")
    .eq("provider", "m365").eq("org_id", orgId)
    .maybeSingle();
  if (!row || (row as { status: string }).status === "disconnected") {
    return { ok: false, note: "no active M365 connection" };
  }
  const existing = row as { webhook_secret: string | null; subscription_id_users: string | null; subscription_id_groups: string | null };
  const clientState = existing.webhook_secret || crypto.randomUUID();

  const { accessToken } = await graphTokenFor(orgId);
  const expiresAt = new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();

  const usersSubId = await upsertSubscription(accessToken, existing.subscription_id_users, "users", clientState, expiresAt);
  const groupsSubId = await upsertSubscription(accessToken, existing.subscription_id_groups, "groups", clientState, expiresAt);

  await admin.from("org_integrations").update({
    subscription_id_users: usersSubId,
    subscription_id_groups: groupsSubId,
    subscription_expires_at: expiresAt,
    webhook_secret: clientState,
  }).eq("provider", "m365").eq("org_id", orgId);

  return { ok: true, users: usersSubId, groups: groupsSubId, expires_at: expiresAt };
}

// Idempotent: PATCH if id given and still alive, POST otherwise. Returns
// the (possibly-new) subscription id.
async function upsertSubscription(
  accessToken: string,
  existingId: string | null,
  resource: "users" | "groups",
  clientState: string,
  expiresAt: string,
): Promise<string> {
  if (existingId) {
    const patch = await fetch(`${GRAPH_BASE}/subscriptions/${existingId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expirationDateTime: expiresAt }),
    });
    if (patch.ok) return existingId;
    // 404 → subscription expired or deleted on MS side; fall through to create.
    if (patch.status !== 404) {
      console.warn(`[m365-subscribe] PATCH ${resource} ${existingId} failed: ${patch.status} ${(await patch.text()).slice(0, 200)} — recreating`);
    }
  }
  const create = await fetch(`${GRAPH_BASE}/subscriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      changeType: "created,updated,deleted",
      notificationUrl: WEBHOOK_URL,
      resource,
      expirationDateTime: expiresAt,
      clientState,
    }),
  });
  if (!create.ok) {
    throw new Error(`POST /subscriptions for ${resource} failed: ${create.status} ${(await create.text()).slice(0, 400)}`);
  }
  const sub = await create.json() as { id: string };
  return sub.id;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
