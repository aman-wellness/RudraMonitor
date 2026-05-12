// POST /functions/v1/sync-oauth-providers
// Headers: Authorization: Bearer <super-admin JWT>
// Body: { provider?: 'google' | 'azure' | 'all' }   default 'all'
//
// Pushes OAuth client_id/client_secret stored in the integrations table to
// Supabase Auth's project config via the Management API. After a successful
// sync, Sign-in with Google / Microsoft uses the new credentials immediately —
// no redeploy, no dashboard click-through.
//
// Why this exists:
//   Edge functions can't read project Auth config directly, and Supabase Auth
//   doesn't read from our DB. So we maintain the integrations table as the
//   source of truth and push to Auth via Management API on save.
//
// Required setup:
//   1. /admin/integrations page → fill in GOOGLE_OAUTH_*, MICROSOFT_OAUTH_*
//   2. Same page → paste SUPABASE_MANAGEMENT_TOKEN (sbp_… from
//      supabase.com/dashboard/account/tokens). Stored encrypted in the
//      integrations table; never logged.
//   3. Click "Sync to Supabase Auth" in the UI → calls this function.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Project ref is the subdomain of SUPABASE_URL (e.g. https://ttjazaxjhzvrzhptrpmd.supabase.co)
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // ---- Auth: must be super-admin ----
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "missing user token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return json({ error: "invalid token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: appUser } = await admin
    .from("app_users").select("app_role").eq("user_id", userData.user.id).maybeSingle();
  if (appUser?.app_role !== "super_admin") return json({ error: "super_admin only" }, 403);

  // ---- Load OAuth config from integrations table ----
  const cfg = await getIntegrations([
    "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
    "MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET", "MICROSOFT_OAUTH_TENANT_URL",
    "SUPABASE_MANAGEMENT_TOKEN",
  ]);
  if (!cfg.SUPABASE_MANAGEMENT_TOKEN) {
    return json({ error: "SUPABASE_MANAGEMENT_TOKEN not configured in /admin/integrations" }, 400);
  }

  let body: { provider?: string } = {};
  try { body = await req.json(); } catch { /* ok — defaults to 'all' */ }
  const which = body.provider ?? "all";

  // Build the auth-config patch. Each provider is opt-in: we only enable + push
  // values for providers that have both client_id + secret configured.
  const patch: Record<string, unknown> = {};
  const synced: string[] = [];

  if ((which === "all" || which === "google")
      && cfg.GOOGLE_OAUTH_CLIENT_ID && cfg.GOOGLE_OAUTH_CLIENT_SECRET) {
    patch.external_google_enabled = true;
    patch.external_google_client_id = cfg.GOOGLE_OAUTH_CLIENT_ID;
    patch.external_google_secret = cfg.GOOGLE_OAUTH_CLIENT_SECRET;
    synced.push("google");
  }

  if ((which === "all" || which === "azure" || which === "microsoft")
      && cfg.MICROSOFT_OAUTH_CLIENT_ID && cfg.MICROSOFT_OAUTH_CLIENT_SECRET) {
    patch.external_azure_enabled = true;
    patch.external_azure_client_id = cfg.MICROSOFT_OAUTH_CLIENT_ID;
    patch.external_azure_secret = cfg.MICROSOFT_OAUTH_CLIENT_SECRET;
    patch.external_azure_url = cfg.MICROSOFT_OAUTH_TENANT_URL
      || "https://login.microsoftonline.com/common";
    synced.push("azure");
  }

  if (synced.length === 0) {
    return json({ error: "no provider has both client_id + secret configured" }, 400);
  }

  // ---- PATCH Supabase Auth config ----
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${cfg.SUPABASE_MANAGEMENT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const text = await r.text();
    return json({ error: `Management API: ${r.status} ${text}` }, 502);
  }

  // ---- Audit ----
  await admin.from("audit_log").insert({
    actor_user: userData.user.id,
    actor_role: "super_admin",
    action: "oauth.sync",
    target_type: "auth-providers",
    metadata: { providers: synced },
  });

  return json({ ok: true, synced, message: `OAuth synced for: ${synced.join(", ")}` });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
