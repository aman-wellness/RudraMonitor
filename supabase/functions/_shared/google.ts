// Google Workspace client — OAuth-based, one-click connect.
//
// Customer's Workspace super-admin clicks "Connect Google Workspace", which
// redirects to Google with our OAuth client_id and the Admin SDK + gmail.send
// scopes. After consent, oauth-google-callback exchanges the code for a
// refresh_token, stored encrypted on org_integrations.refresh_token_enc.
// This module mints / caches access_tokens from that refresh_token on demand.
//
// Per-org config on org_integrations(provider='google'):
//   tenant_id            = Workspace customer_id (e.g. C03az79cb)
//   impersonate_subject  = the admin email who consented
//   refresh_token_enc    = encrypted offline-access refresh token

import { adminClient, encrypt, decrypt } from "./crypto.ts";
import { getIntegrations } from "./integrations.ts";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADMIN_SDK_BASE = "https://admin.googleapis.com/admin/directory/v1";

export interface OrgGoogleConn {
  org_id: string;
  customer_id: string;            // tenant_id in our schema
  primary_domain: string | null;
  impersonate_subject: string;    // super-admin email to act as
}

export async function loadOrgGoogle(orgId: string): Promise<OrgGoogleConn> {
  const { data, error } = await adminClient()
    .from("org_integrations")
    .select("org_id, tenant_id, primary_domain, impersonate_subject, status")
    .eq("org_id", orgId)
    .eq("provider", "google")
    .maybeSingle();
  if (error) throw new Error(`loadOrgGoogle: ${error.message}`);
  if (!data) throw new Error("Google Workspace not connected for this org");
  if (data.status === "disconnected") throw new Error("Google integration was disconnected — reconnect from Integrations page");
  if (!data.impersonate_subject) throw new Error("Google impersonate_subject missing — reconnect from Integrations page");
  return {
    org_id: data.org_id,
    customer_id: data.tenant_id ?? "my_customer",
    primary_domain: data.primary_domain,
    impersonate_subject: data.impersonate_subject,
  };
}

// ---------- Token mint via refresh_token ----------

export async function googleTokenFor(orgId: string): Promise<string> {
  const admin = adminClient();

  // Read the row (including the encrypted refresh_token and the current cached
  // access token + expiry). Reuse the cached access_token if it still has
  // > 60s to live.
  const { data: row, error } = await admin
    .from("org_integrations")
    .select("refresh_token_enc, access_token_enc, access_token_expires_at, status")
    .eq("org_id", orgId).eq("provider", "google").maybeSingle();
  if (error) throw new Error(`loadOrgGoogle: ${error.message}`);
  if (!row) throw new Error("Google Workspace not connected for this org");
  if (row.status === "disconnected") throw new Error("Google integration was disconnected — reconnect from Integrations page");

  const nowMs = Date.now();
  const expMs = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0;
  if (row.access_token_enc && expMs - nowMs > 60_000) {
    const cached = await decrypt(row.access_token_enc as string, "DIRECTORY_TOKEN_ENC_KEY");
    return cached;
  }

  if (!row.refresh_token_enc) {
    throw new Error("Google refresh_token missing — reconnect from /employees/integrations");
  }
  const refreshToken = await decrypt(row.refresh_token_enc as string, "DIRECTORY_TOKEN_ENC_KEY");

  const cfg = await getIntegrations(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]);
  const clientId = cfg.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = cfg.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID/SECRET missing in Admin → Integrations");
  }

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`google token: ${resp.status} ${await resp.text()}`);
  const j = await resp.json() as { access_token: string; expires_in: number };

  // Persist the freshly-minted token so other invocations can reuse it.
  const accessTokenEnc = await encrypt(j.access_token, "DIRECTORY_TOKEN_ENC_KEY");
  await admin.from("org_integrations").update({
    access_token_enc: accessTokenEnc,
    access_token_expires_at: new Date(Date.now() + (j.expires_in - 60) * 1000).toISOString(),
  }).eq("org_id", orgId).eq("provider", "google");

  return j.access_token;
}

// ---------- HTTP wrappers (Directory API) ----------

export async function googleJson<T = unknown>(orgId: string, opts: { method?: string; path: string; body?: unknown; query?: Record<string, string | number | undefined> }): Promise<T> {
  const token = await googleTokenFor(orgId);
  const qs = opts.query
    ? "?" + Object.entries(opts.query).filter(([_, v]) => v !== undefined).map(
        ([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
    : "";
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const resp = await fetch(`${ADMIN_SDK_BASE}${opts.path}${qs}`, init);
  if (!resp.ok) throw new Error(`Google ${opts.method ?? "GET"} ${opts.path}: ${resp.status} ${await resp.text()}`);
  if (resp.status === 204) return {} as T;
  return await resp.json() as T;
}

/** Iterate every page of an Admin Directory list endpoint via pageToken. */
export async function* googlePaged<T = Record<string, unknown>>(orgId: string, path: string, listKey: string, query?: Record<string, string | number | undefined>): AsyncGenerator<T> {
  let pageToken: string | undefined;
  do {
    const q = { ...(query ?? {}), pageToken, maxResults: 200 };
    const j = await googleJson<Record<string, unknown>>(orgId, { path, query: q });
    const items = (j[listKey] ?? []) as T[];
    for (const it of items) yield it;
    pageToken = (j["nextPageToken"] as string | undefined) ?? undefined;
  } while (pageToken);
}

