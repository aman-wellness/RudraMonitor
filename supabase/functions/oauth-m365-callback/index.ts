// POST /functions/v1/oauth-m365-callback
// Headers: Authorization: Bearer <user JWT>
// Body:    { tenant_id: string, primary_domain?: string }
//
// Why this exists: for Microsoft 365 admin-consent (app-only Graph access) we
// don't actually need a code-exchange — the redirect from
// `https://login.microsoftonline.com/{tenant}/adminconsent?client_id=...` just
// hands us a query param `tenant` (the customer's tenant id) once their global
// admin clicks "Accept". The browser captures that, then calls this function
// to persist it on org_integrations. We then immediately mint a Graph token
// to confirm the consent took effect and mark the row 'active'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
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
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "invalid token" }, 401);
  const callerId = userData.user.id;
  const callerEmail = userData.user.email ?? "";

  let body: { tenant_id?: string; primary_domain?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const tenantId = (body.tenant_id ?? "").trim();
  const primaryDomain = (body.primary_domain ?? "").trim() || null;
  if (!tenantId) return json({ error: "tenant_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve caller's org — owners or org admins can connect tenants.
  const { resolveWriterOrgId } = await import("../_shared/auth-org.ts");
  const orgId = await resolveWriterOrgId(admin, callerId);
  if (!orgId) return json({ error: "only the org owner or an org admin can connect M365" }, 403);

  // Verify the consent works by minting a token immediately.
  const cfg = await getIntegrations(["DIRECTORY_M365_CLIENT_ID", "DIRECTORY_M365_CLIENT_SECRET"]);
  if (!cfg.DIRECTORY_M365_CLIENT_ID || !cfg.DIRECTORY_M365_CLIENT_SECRET) {
    return json({ error: "DIRECTORY_M365_CLIENT_ID/SECRET not configured (Admin → Integrations)" }, 500);
  }
  const tr = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.DIRECTORY_M365_CLIENT_ID,
      client_secret: cfg.DIRECTORY_M365_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!tr.ok) {
    const detail = await tr.text();
    return json({ error: `tenant token mint failed — has admin consent been granted? ${detail}` }, 400);
  }

  // Quick sanity probe — fetch the tenant's organization name + verified domain.
  const tj = await tr.json();
  let resolvedDomain = primaryDomain;
  try {
    const probe = await fetch("https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains", {
      headers: { Authorization: `Bearer ${tj.access_token}` },
    });
    if (probe.ok) {
      const pj = await probe.json();
      const org0 = pj.value?.[0];
      const def = org0?.verifiedDomains?.find((d: { isDefault?: boolean }) => d.isDefault) ?? org0?.verifiedDomains?.[0];
      if (!resolvedDomain && def?.name) resolvedDomain = def.name;
    }
  } catch { /* non-fatal */ }

  // Upsert org_integrations row as active.
  const { error: upErr } = await admin
    .from("org_integrations")
    .upsert({
      org_id: orgId,
      provider: "m365",
      tenant_id: tenantId,
      primary_domain: resolvedDomain,
      connected_by_email: callerEmail,
      status: "active",
      status_detail: null,
      scopes: ["User.ReadWrite.All", "Group.ReadWrite.All", "Directory.ReadWrite.All", "GroupMember.ReadWrite.All", "Sites.ReadWrite.All", "Channel.ReadWrite.All", "ChannelMember.ReadWrite.All"],
    }, { onConflict: "org_id,provider" });
  if (upErr) return json({ error: `save: ${upErr.message}` }, 500);

  // Fire-and-forget: subscribe to Graph Change Notifications so future
  // directory edits stream in real-time instead of waiting for the next
  // manual or cron-driven full sync. Failure here doesn't break the
  // connect flow — the renewal cron will pick it up on its next pass.
  queueBackground(async () => {
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/m365-subscribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ org_id: orgId }),
      });
      if (!r.ok) console.warn(`[oauth-m365-callback] subscribe failed for org ${orgId}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    } catch (e) {
      console.warn(`[oauth-m365-callback] subscribe call errored for org ${orgId}: ${(e as Error).message}`);
    }
  });

  return json({ ok: true, tenant_id: tenantId, primary_domain: resolvedDomain }, 200);
});

function queueBackground(fn: () => Promise<unknown>): void {
  const p = fn();
  // deno-lint-ignore no-explicit-any
  if (typeof (globalThis as any).EdgeRuntime !== "undefined" && (globalThis as any).EdgeRuntime?.waitUntil) {
    (globalThis as any).EdgeRuntime.waitUntil(p);
  }
}

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
