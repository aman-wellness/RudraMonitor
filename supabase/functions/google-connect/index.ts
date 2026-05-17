// POST /functions/v1/google-connect
// Headers: Authorization: Bearer <user JWT>
// Body:    { customer_id?: string, primary_domain?: string, impersonate_subject: string }
//
// Google Workspace integration uses a service account with Domain-Wide
// Delegation — the customer admin pastes our SA client ID + scopes into
// Google Admin → Security → API controls once. No OAuth round-trip needed.
// This function only collects which super-admin email we should impersonate
// (and optionally the customer_id), saves them on org_integrations, then
// verifies by minting a token via the SA and calling /users/me.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/admin.directory.group.member",
  "https://www.googleapis.com/auth/admin.directory.domain.readonly",
  "https://www.googleapis.com/auth/admin.directory.orgunit",
  // Gmail send for routing EM emails (cred requests, offboarding) through
  // the customer's own mailbox when M365 isn't connected.
  "https://www.googleapis.com/auth/gmail.send",
];

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

  let body: { customer_id?: string; primary_domain?: string; impersonate_subject?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const customerId = (body.customer_id ?? "my_customer").trim();
  const primaryDomain = (body.primary_domain ?? "").trim() || null;
  const subject = (body.impersonate_subject ?? "").trim().toLowerCase();
  if (!subject || !subject.includes("@")) return json({ error: "impersonate_subject (admin email) required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { resolveWriterOrgId } = await import("../_shared/auth-org.ts");
  const orgId = await resolveWriterOrgId(admin, callerId);
  if (!orgId) return json({ error: "only the org owner or an org admin can connect Google" }, 403);

  // Verify SA + DWD by minting a token and calling /users/{subject}.
  const cfg = await getIntegrations(["GOOGLE_SA_CLIENT_EMAIL", "GOOGLE_SA_PRIVATE_KEY"]);
  if (!cfg.GOOGLE_SA_CLIENT_EMAIL || !cfg.GOOGLE_SA_PRIVATE_KEY) {
    return json({ error: "GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY not configured (Admin → Integrations)" }, 500);
  }
  let token: string;
  try {
    token = await mintGoogleToken(cfg.GOOGLE_SA_CLIENT_EMAIL, cfg.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n"), subject);
  } catch (e) {
    return json({ error: `token mint failed (check DWD configured for SA in Google Admin): ${(e as Error).message}` }, 400);
  }
  const probe = await fetch(`https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(subject)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!probe.ok) {
    return json({ error: `probe call failed — admin impersonation may be incorrect: ${await probe.text()}` }, 400);
  }
  const probeJson = await probe.json();
  const resolvedCustomer = probeJson.customerId ?? customerId;
  const resolvedDomain = primaryDomain ?? probeJson.primaryEmail?.split("@")[1] ?? null;

  const { error: upErr } = await admin
    .from("org_integrations")
    .upsert({
      org_id: orgId,
      provider: "google",
      tenant_id: resolvedCustomer,
      primary_domain: resolvedDomain,
      impersonate_subject: subject,
      connected_by_email: callerEmail,
      status: "active",
      status_detail: null,
      scopes: SCOPES,
    }, { onConflict: "org_id,provider" });
  if (upErr) return json({ error: `save: ${upErr.message}` }, 500);

  return json({ ok: true, customer_id: resolvedCustomer, primary_domain: resolvedDomain, impersonate_subject: subject }, 200);
});

// ---- helpers (duplicated from _shared/google.ts so this fn stays standalone) ----

async function mintGoogleToken(saEmail: string, pemKey: string, subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: saEmail, sub: subject, scope: SCOPES.join(" "), aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const jwt = await signRs256Jwt(claim, pemKey);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.access_token as string;
}

async function signRs256Jwt(claim: Record<string, unknown>, pkcs8Pem: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = (obj: unknown) => b64u(new TextEncoder().encode(JSON.stringify(obj)));
  const input = `${enc(header)}.${enc(claim)}`;
  const der = pemToDer(pkcs8Pem);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${b64u(new Uint8Array(sig))}`;
}
function pemToDer(pem: string): ArrayBuffer {
  const cleaned = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function b64u(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
