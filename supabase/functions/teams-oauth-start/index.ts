// POST /functions/v1/teams-oauth-start
// Headers: Authorization: Bearer <user JWT>   (org owner / admin)
// Body:    { tenant_id?: string }            (optional — 'common' if omitted)
//
// Returns: { authorize_url, state }
//
// The browser navigates to authorize_url. Microsoft asks the admin to sign
// in and consent to ChannelMessage.Send + Chat.ReadWrite + offline_access.
// On success Microsoft redirects to teams-oauth-callback with code+state.
//
// `state` is HMAC-signed `org_id:nonce:expiry` so the callback can verify
// the redirect was actually initiated by a logged-in admin of this org.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegration } from "../_shared/integrations.ts";
import { hmacSign, randomTokenBase64Url } from "../_shared/hmac.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Delegated scopes needed to:
//   - post messages to a channel  → ChannelMessage.Send
//   - read joined teams + channels (for the picker)  → Team.ReadBasic.All, Channel.ReadBasic.All
//   - refresh without re-prompt  → offline_access
const SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "User.Read",
  "ChannelMessage.Send",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
].join(" ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: mem } = await admin.from("org_members")
    .select("org_id, role").eq("user_id", u.user.id).limit(1).maybeSingle();
  if (!mem) return json({ error: "no org for caller" }, 403);
  if (mem.role !== "owner" && mem.role !== "admin") {
    return json({ error: "owner/admin only" }, 403);
  }
  const orgId = mem.org_id as string;

  let body: { tenant_id?: string };
  try { body = await req.json(); } catch { body = {}; }
  const tenant = (body.tenant_id ?? "").trim() || "common";

  const clientId = await getIntegration("DIRECTORY_M365_CLIENT_ID").catch(() => "");
  if (!clientId) return json({ error: "DIRECTORY_M365_CLIENT_ID not configured" }, 500);

  // Build HMAC-signed state. Format: `<orgId>:<nonce>:<expiry>:<sig>`.
  const nonce = randomTokenBase64Url(16);
  const expiry = Math.floor(Date.now() / 1000) + 600;       // 10 min
  const payload = `${orgId}:${nonce}:${expiry}`;
  const sig = await hmacSign(payload);
  const state = `${payload}:${sig}`;

  // The internal SUPABASE_URL is `http://kong:8000` in self-hosted Docker
  // — Microsoft rejects that as a redirect. Use the public URL configured
  // in the integrations table.
  const publicBase = (await getIntegration("PUBLIC_API_BASE_URL").catch(() => "")) || "https://api.rudrans.com";
  const redirect = `${publicBase}/functions/v1/teams-oauth-callback`;
  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  return json({ authorize_url: url.toString(), state }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
