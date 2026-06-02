// GET /functions/v1/teams-oauth-callback?code=...&state=...
//
// Microsoft redirects the admin's browser here after consent. We:
//   1. Verify the HMAC on `state` (proves the request was initiated by a
//      logged-in org admin within the last 10 min, and binds the org).
//   2. Exchange `code` for an access_token + refresh_token.
//   3. Probe `/me` to capture the signed-in admin's email + tenant.
//   4. Encrypt the refresh_token and persist it on `org_otp_settings`.
//   5. Redirect the browser back to /employees/otp-settings?teams=connected.
//
// Errors redirect with `?teams=error&msg=<detail>` so the page can show a
// banner instead of dumping JSON.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { encrypt } from "../_shared/crypto.ts";
import { getIntegration, getIntegrations } from "../_shared/integrations.ts";
import { hmacVerify } from "../_shared/hmac.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const errParam = url.searchParams.get("error");
  const errDesc = url.searchParams.get("error_description") ?? "";

  // Where the browser ends up regardless of outcome.
  const appBase = await getIntegration("MAGIC_LINK_BASE_URL").catch(() => "");
  const settingsUrl = (appBase || "https://ems.wellnessextract.com") + "/employees/otp-settings";

  if (errParam) return redirect(`${settingsUrl}?teams=error&msg=${encodeURIComponent(errParam + ": " + errDesc)}`);
  if (!code || !state) return redirect(`${settingsUrl}?teams=error&msg=missing+code+or+state`);

  // ── State verification ───────────────────────────────────────────────
  const parts = state.split(":");
  if (parts.length !== 4) return redirect(`${settingsUrl}?teams=error&msg=malformed+state`);
  const [orgId, nonce, expiry, sig] = parts;
  if (!await hmacVerify(`${orgId}:${nonce}:${expiry}`, sig)) {
    return redirect(`${settingsUrl}?teams=error&msg=bad+state+signature`);
  }
  if (Number(expiry) * 1000 < Date.now()) {
    return redirect(`${settingsUrl}?teams=error&msg=state+expired+please+retry`);
  }

  // ── Code exchange ────────────────────────────────────────────────────
  const cfg = await getIntegrations(["DIRECTORY_M365_CLIENT_ID", "DIRECTORY_M365_CLIENT_SECRET"]);
  if (!cfg.DIRECTORY_M365_CLIENT_ID || !cfg.DIRECTORY_M365_CLIENT_SECRET) {
    return redirect(`${settingsUrl}?teams=error&msg=server+not+configured`);
  }
  // Must match the redirect_uri the start step sent to Microsoft — i.e.
  // the public URL, not the internal Docker hostname.
  const publicBase = (await getIntegration("PUBLIC_API_BASE_URL").catch(() => "")) || "https://api-ems.wellnessextract.com";
  const redirectUri = `${publicBase}/functions/v1/teams-oauth-callback`;
  void SUPABASE_URL;
  const tokResp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.DIRECTORY_M365_CLIENT_ID,
      client_secret: cfg.DIRECTORY_M365_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokResp.ok) {
    const detail = (await tokResp.text()).slice(0, 300);
    return redirect(`${settingsUrl}?teams=error&msg=${encodeURIComponent("token: " + detail)}`);
  }
  const tok = await tokResp.json() as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };
  if (!tok.refresh_token) {
    return redirect(`${settingsUrl}?teams=error&msg=no+refresh+token+returned`);
  }

  // ── Probe /me for email + tenant ─────────────────────────────────────
  let adminEmail: string | null = null;
  let tenantId: string | null = null;
  try {
    const meResp = await fetch("https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail,id", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (meResp.ok) {
      const me = await meResp.json() as { userPrincipalName?: string; mail?: string };
      adminEmail = me.mail ?? me.userPrincipalName ?? null;
    }
    // tenant id is inside the id_token JWT (no signature check needed here).
    if (tok.id_token) {
      const payload = JSON.parse(atob(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      tenantId = payload.tid ?? null;
    }
  } catch { /* non-fatal */ }

  // ── Persist ──────────────────────────────────────────────────────────
  let refreshEnc: string;
  try {
    refreshEnc = await encrypt(tok.refresh_token, "CRED_VAULT_ENC_KEY");
  } catch (e) {
    return redirect(`${settingsUrl}?teams=error&msg=${encodeURIComponent("encrypt: " + (e as Error).message)}`);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const upsertRow: Record<string, unknown> = {
    org_id: orgId,
    teams_admin_refresh_token_enc: refreshEnc,
    teams_admin_email: adminEmail,
  };
  if (tenantId) upsertRow.teams_tenant_id = tenantId;

  const { error: upErr } = await admin
    .from("org_otp_settings")
    .upsert(upsertRow, { onConflict: "org_id" });
  if (upErr) return redirect(`${settingsUrl}?teams=error&msg=${encodeURIComponent("save: " + upErr.message)}`);

  return redirect(`${settingsUrl}?teams=connected&email=${encodeURIComponent(adminEmail ?? "")}`);
});

function redirect(to: string): Response {
  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders, Location: to },
  });
}
