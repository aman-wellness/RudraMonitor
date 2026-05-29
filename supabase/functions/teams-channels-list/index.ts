// POST /functions/v1/teams-channels-list
// Headers: Authorization: Bearer <user JWT>
//
// After the admin signs in via teams-oauth-callback, the settings UI calls
// this to populate a "pick your team + channel" dropdown. We use the
// stored refresh token (the admin's own) to call Graph:
//   GET /me/joinedTeams
//   GET /teams/{id}/channels
// Then return a flat list the UI can render.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { decrypt } from "../_shared/crypto.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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
    .select("org_id").eq("user_id", u.user.id).limit(1).maybeSingle();
  if (!mem) return json({ error: "no org" }, 403);
  const orgId = mem.org_id as string;

  const { data: s } = await admin
    .from("org_otp_settings")
    .select("teams_admin_refresh_token_enc")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!s?.teams_admin_refresh_token_enc) {
    return json({ error: "no Teams connection — sign in with Microsoft first" }, 400);
  }

  // Mint access token.
  const cfg = await getIntegrations(["DIRECTORY_M365_CLIENT_ID", "DIRECTORY_M365_CLIENT_SECRET"]);
  if (!cfg.DIRECTORY_M365_CLIENT_ID || !cfg.DIRECTORY_M365_CLIENT_SECRET) {
    return json({ error: "DIRECTORY_M365_CLIENT_ID/SECRET missing" }, 500);
  }
  let refresh: string;
  try { refresh = await decrypt(s.teams_admin_refresh_token_enc, "CRED_VAULT_ENC_KEY"); }
  catch (e) { return json({ error: `decrypt: ${(e as Error).message}` }, 500); }

  const tokR = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.DIRECTORY_M365_CLIENT_ID,
      client_secret: cfg.DIRECTORY_M365_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope: "offline_access Team.ReadBasic.All Channel.ReadBasic.All",
    }),
  });
  if (!tokR.ok) return json({ error: `refresh: ${(await tokR.text()).slice(0, 200)}` }, 502);
  const { access_token } = await tokR.json() as { access_token: string };

  // List teams the admin is a member of.
  const tmR = await fetch("https://graph.microsoft.com/v1.0/me/joinedTeams?$select=id,displayName", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!tmR.ok) return json({ error: `joinedTeams: ${tmR.status}` }, 502);
  const tmJ = await tmR.json() as { value: Array<{ id: string; displayName: string }> };

  // For each team, fetch channels in parallel (cap at 25 teams to avoid throttling).
  const teams: Array<{ id: string; displayName: string; channels: Array<{ id: string; displayName: string }> }> = [];
  const slice = (tmJ.value ?? []).slice(0, 25);
  await Promise.all(slice.map(async (t) => {
    const cR = await fetch(`https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(t.id)}/channels?$select=id,displayName`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const cJ = cR.ok ? await cR.json() as { value: Array<{ id: string; displayName: string }> } : { value: [] };
    teams.push({ id: t.id, displayName: t.displayName, channels: cJ.value ?? [] });
  }));

  teams.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return json({ teams }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
