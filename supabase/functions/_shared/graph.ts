// Microsoft Graph client scoped to a CUSTOMER organisation (not our own
// internal mailbox). Used by every Feature-2/3/5 edge function that talks to
// the customer's M365 tenant.
//
// Auth model: customer admin grants admin-consent to our multi-tenant app
// registration; we then mint app-only tokens via client_credentials against
// THEIR tenant_id. App-only tokens have no refresh token (they're short-lived
// JWTs we re-mint as needed) — we cache them in org_integrations for ~50min.
//
// Our app registration credentials (CLIENT_ID, CLIENT_SECRET) come from the
// `integrations` table (DIRECTORY_M365_CLIENT_ID / _SECRET). The customer's
// tenant_id lives on org_integrations.tenant_id.

import { adminClient } from "./crypto.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { getIntegrations } from "./integrations.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface OrgM365Conn {
  org_id: string;
  tenant_id: string;
  primary_domain: string | null;
  status: string;
  scopes: string[];
}

/** Load the org's M365 integration row; throws if not usable.
 *  Status is informational only (active / syncing / error / pending) — Graph
 *  calls work whenever the tenant_id is present and consent is in place, so we
 *  only gate on tenant_id + non-disconnected. */
export async function loadOrgM365(orgId: string): Promise<OrgM365Conn> {
  const { data, error } = await adminClient()
    .from("org_integrations")
    .select("org_id, tenant_id, primary_domain, status, scopes")
    .eq("org_id", orgId)
    .eq("provider", "m365")
    .maybeSingle();
  if (error) throw new Error(`loadOrgM365: ${error.message}`);
  if (!data) throw new Error("M365 not connected for this org");
  if (data.status === "disconnected") throw new Error("M365 integration was disconnected — reconnect from Integrations page");
  if (!data.tenant_id) throw new Error("M365 tenant_id missing — reconnect M365 from Integrations page");
  return data as OrgM365Conn;
}

/** Mint (or reuse cached) app-only access token for the customer's tenant. */
export async function graphTokenFor(orgId: string): Promise<{ accessToken: string; tenantId: string }> {
  const admin = adminClient();
  const { data: row, error } = await admin
    .from("org_integrations")
    .select("tenant_id, access_token_enc, access_token_expires_at, status")
    .eq("org_id", orgId)
    .eq("provider", "m365")
    .maybeSingle();
  if (error) throw new Error(`graphTokenFor: ${error.message}`);
  if (!row || !row.tenant_id) throw new Error("M365 not connected for this org");

  // Reuse cached token if it has > 60s to live.
  const nowMs = Date.now();
  const expMs = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0;
  if (row.access_token_enc && expMs - nowMs > 60_000) {
    const cached = await decrypt(row.access_token_enc, "DIRECTORY_TOKEN_ENC_KEY");
    if (cached) return { accessToken: cached, tenantId: row.tenant_id };
  }

  // Mint fresh.
  const cfg = await getIntegrations(["DIRECTORY_M365_CLIENT_ID", "DIRECTORY_M365_CLIENT_SECRET"]);
  const CLIENT_ID = cfg.DIRECTORY_M365_CLIENT_ID;
  const CLIENT_SECRET = cfg.DIRECTORY_M365_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("DIRECTORY_M365_CLIENT_ID/SECRET missing in Admin → Integrations");
  }

  const tr = await fetch(`https://login.microsoftonline.com/${row.tenant_id}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!tr.ok) throw new Error(`graph token: ${await tr.text()}`);
  const tj = await tr.json();
  const accessToken = tj.access_token as string;
  const expiresInSec = (tj.expires_in as number) ?? 3600;
  const expiresAt = new Date(nowMs + expiresInSec * 1000).toISOString();

  // Cache (encrypted) so subsequent calls in the next ~hour skip the mint.
  const enc = await encrypt(accessToken, "DIRECTORY_TOKEN_ENC_KEY");
  await admin
    .from("org_integrations")
    .update({ access_token_enc: enc, access_token_expires_at: expiresAt })
    .eq("org_id", orgId)
    .eq("provider", "m365");

  return { accessToken, tenantId: row.tenant_id };
}

/**
 * Mint an app-only access token scoped to Exchange Online for the customer's
 * tenant. Used by the signature-push flow which calls the Exchange PowerShell
 * REST endpoint at `outlook.office365.com/adminapi/beta/...` — that endpoint
 * does NOT accept Graph tokens; it needs a separate audience.
 *
 * Prerequisites in the customer's tenant (documented on the Email Signatures
 * settings page):
 *   1. API permission `Office 365 Exchange Online → Exchange.ManageAsApp`
 *      granted admin-consent on our app registration.
 *   2. `Exchange Administrator` directory role assigned to our app's service
 *      principal in Entra.
 *
 * No caching — tokens are cheap (~50ms mint) and signature pushes are rare
 * admin-triggered events. Keeping this stateless also avoids polluting
 * `org_integrations.access_token_enc` (which is Graph-scoped).
 */
export async function exchangeTokenFor(orgId: string): Promise<{ accessToken: string; tenantId: string }> {
  const admin = adminClient();
  const { data: row, error } = await admin
    .from("org_integrations")
    .select("tenant_id, status")
    .eq("org_id", orgId)
    .eq("provider", "m365")
    .maybeSingle();
  if (error) throw new Error(`exchangeTokenFor: ${error.message}`);
  if (!row || !row.tenant_id) throw new Error("M365 not connected for this org");

  const cfg = await getIntegrations(["DIRECTORY_M365_CLIENT_ID", "DIRECTORY_M365_CLIENT_SECRET"]);
  const CLIENT_ID = cfg.DIRECTORY_M365_CLIENT_ID;
  const CLIENT_SECRET = cfg.DIRECTORY_M365_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("DIRECTORY_M365_CLIENT_ID/SECRET missing in Admin → Integrations");
  }

  const tr = await fetch(`https://login.microsoftonline.com/${row.tenant_id}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://outlook.office365.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!tr.ok) {
    const txt = await tr.text();
    // Surface the two most common admin misconfigurations with actionable text
    // so the frontend can render a targeted "Fix in Azure" banner.
    if (txt.includes("AADSTS500011") || txt.includes("AADSTS7000229")) {
      throw new Error(
        "Exchange Online API permission missing. Grant admin-consent for `Exchange.ManageAsApp` (Office 365 Exchange Online) on the track force app registration in Azure.",
      );
    }
    throw new Error(`exchange token: ${txt}`);
  }
  const tj = await tr.json();
  return { accessToken: tj.access_token as string, tenantId: row.tenant_id };
}

// ---------- HTTP wrappers ----------

interface GraphRequestOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;           // path after /v1.0 — must start with "/"
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

export async function graphFetch(orgId: string, opts: GraphRequestOpts): Promise<Response> {
  const { accessToken } = await graphTokenFor(orgId);
  const qs = opts.query
    ? "?" + Object.entries(opts.query).filter(([_, v]) => v !== undefined).map(
        ([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
    : "";
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ConsistencyLevel: "eventual",
    },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  // Retry with one fresh token on 401 (handles cache-staleness across restarts).
  let resp = await fetch(`${GRAPH_BASE}${opts.path}${qs}`, init);
  if (resp.status === 401) {
    // Force a re-mint by zeroing expiry.
    await adminClient().from("org_integrations")
      .update({ access_token_expires_at: new Date(0).toISOString() })
      .eq("org_id", orgId).eq("provider", "m365");
    const { accessToken: fresh } = await graphTokenFor(orgId);
    (init.headers as Record<string, string>).Authorization = `Bearer ${fresh}`;
    resp = await fetch(`${GRAPH_BASE}${opts.path}${qs}`, init);
  }
  // Honour 429 Retry-After with one polite retry.
  if (resp.status === 429) {
    const wait = Number(resp.headers.get("retry-after") || "1");
    await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
    resp = await fetch(`${GRAPH_BASE}${opts.path}${qs}`, init);
  }
  return resp;
}

export async function graphJson<T = unknown>(orgId: string, opts: GraphRequestOpts): Promise<T> {
  const resp = await graphFetch(orgId, opts);
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Graph ${opts.method ?? "GET"} ${opts.path}: ${resp.status} ${txt}`);
  }
  if (resp.status === 204) return {} as T;
  return await resp.json() as T;
}

/** Iterate every page of a Graph list endpoint (@odata.nextLink). Yields each item. */
export async function* graphPaged<T = Record<string, unknown>>(orgId: string, path: string, query?: Record<string, string | number | undefined>): AsyncGenerator<T> {
  let url: string | null = `${GRAPH_BASE}${path}` + (query
    ? "?" + Object.entries(query).filter(([_, v]) => v !== undefined).map(
        ([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
    : "");
  while (url) {
    const { accessToken } = await graphTokenFor(orgId);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: "eventual" } });
    if (!r.ok) throw new Error(`Graph paged ${url}: ${r.status} ${await r.text()}`);
    const j = await r.json() as { value?: T[]; "@odata.nextLink"?: string };
    for (const item of (j.value ?? [])) yield item;
    url = j["@odata.nextLink"] ?? null;
  }
}

/** Run a Graph $batch (max 20 requests per batch). Returns parallel array of responses. */
export async function graphBatch(orgId: string, requests: Array<{ id: string; method: string; url: string; body?: unknown; headers?: Record<string, string> }>): Promise<Array<{ id: string; status: number; body: unknown }>> {
  const chunks: typeof requests[] = [];
  for (let i = 0; i < requests.length; i += 20) chunks.push(requests.slice(i, i + 20));

  const out: Array<{ id: string; status: number; body: unknown }> = [];
  for (const chunk of chunks) {
    const j = await graphJson<{ responses: Array<{ id: string; status: number; body: unknown }> }>(orgId, {
      method: "POST",
      path: "/$batch",
      body: { requests: chunk.map((r) => ({ ...r, headers: r.headers ?? { "Content-Type": "application/json" } })) },
    });
    out.push(...(j.responses ?? []));
  }
  return out;
}
