// POST /functions/v1/oauth-google-callback
// Headers: Authorization: Bearer <user JWT>
// Body:    { code: string, redirect_uri: string }
//
// One-click Google Workspace connect — replaces the old service-account +
// Domain-wide-delegation setup. The customer's super-admin clicks "Connect
// Google Workspace" in the dashboard; we redirect to Google with our OAuth
// client_id + the admin / Gmail scopes; admin approves; Google sends back a
// `code` which the browser hands to this function. We exchange it for a
// refresh_token (offline access) and store it encrypted on org_integrations.
// All subsequent Admin SDK / Gmail calls mint fresh access tokens from that
// refresh_token — no separate service account required.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { encrypt } from "../_shared/crypto.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = bearer(req);
  if (!jwt) return json({ error: "missing user token" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  let body: { code?: string; redirect_uri?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const code = body.code?.trim();
  const redirectUri = body.redirect_uri?.trim();
  if (!code || !redirectUri) return json({ error: "code + redirect_uri required" }, 400);

  const cfg = await getIntegrations(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]);
  const clientId = cfg.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = cfg.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return json({ error: "GOOGLE_OAUTH_CLIENT_ID/SECRET not configured" }, 500);
  }

  // Exchange code → tokens.
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    return json({ error: `token exchange: ${await tokenResp.text()}` }, 400);
  }
  const tokens = await tokenResp.json() as {
    access_token: string; refresh_token?: string; expires_in: number; scope: string; id_token?: string;
  };
  if (!tokens.refresh_token) {
    return json({
      error: "Google returned no refresh_token. Re-grant access from https://myaccount.google.com/permissions and retry — or add prompt=consent to the auth URL.",
    }, 400);
  }

  // Get the signed-in user's email via OpenID userinfo (works for any Google
  // account — Workspace or personal Gmail). We then verify they're a real
  // Workspace super-admin by looking themselves up in Admin SDK.
  const userinfoResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userinfoResp.ok) {
    return json({ error: `userinfo: ${userinfoResp.status} ${await userinfoResp.text()}` }, 400);
  }
  const userinfo = await userinfoResp.json() as { email?: string; hd?: string; name?: string };
  const adminEmail = userinfo.email;
  if (!adminEmail) return json({ error: "Could not read email from Google account" }, 400);
  if (!userinfo.hd) {
    return json({
      error: `Signed-in account "${adminEmail}" is not a Google Workspace account. Sign in with your company's Workspace super-admin (e.g. you@yourcompany.com on a Workspace domain), not a personal Gmail.`,
    }, 400);
  }

  // Look the user up in their own Workspace to verify super-admin status +
  // grab the customerId / primaryDomain.
  const meResp = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(adminEmail)}`,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  );
  if (!meResp.ok) {
    const errTxt = await meResp.text();
    if (meResp.status === 404) {
      return json({
        error: `Workspace lookup failed for ${adminEmail}: account not found in Admin SDK directory. This usually means (a) ${userinfo.hd} isn't a paid Google Workspace tenant, or (b) Admin SDK API hasn't propagated yet — wait 2 min and retry.`,
      }, 400);
    }
    return json({ error: `verify (admin sdk): ${meResp.status} ${errTxt}` }, 400);
  }
  const me = await meResp.json() as { primaryEmail: string; customerId: string; isAdmin?: boolean };
  if (!me.isAdmin) {
    return json({ error: `Connected account ${adminEmail} is not a Workspace super-admin. Sign in with a super-admin account so we can manage users, groups, and send mail on the org's behalf.` }, 403);
  }

  // Find the caller's org.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { resolveWriterOrgId } = await import("../_shared/auth-org.ts");
  const orgId = await resolveWriterOrgId(admin, u.user.id);
  if (!orgId) return json({ error: "only the org owner or an org admin can connect" }, 403);

  const primaryDomain = me.primaryEmail.includes("@") ? me.primaryEmail.split("@")[1] : null;

  const refreshTokenEnc = await encrypt(tokens.refresh_token, "DIRECTORY_TOKEN_ENC_KEY");
  const accessTokenEnc = await encrypt(tokens.access_token, "DIRECTORY_TOKEN_ENC_KEY");
  const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString();

  await admin.from("org_integrations").upsert({
    org_id: orgId,
    provider: "google",
    tenant_id: me.customerId,
    primary_domain: primaryDomain,
    impersonate_subject: me.primaryEmail,
    connected_by_email: me.primaryEmail,
    refresh_token_enc: refreshTokenEnc,
    access_token_enc: accessTokenEnc,
    access_token_expires_at: expiresAt,
    status: "active",
    status_detail: null,
    scopes: tokens.scope.split(/\s+/),
  }, { onConflict: "org_id,provider" });

  return json({ ok: true, customer_id: me.customerId, primary_domain: primaryDomain, admin_email: me.primaryEmail }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
