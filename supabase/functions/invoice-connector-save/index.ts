// POST /functions/v1/invoice-connector-save
// Headers: Authorization: Bearer <user JWT>
// Body: { credential_id, provider, token }      // single-token providers (Stripe, OpenAI, Anthropic)
//       { credential_id, provider, key_id, key_secret }   // dual-token (Razorpay, AWS)
//       { credential_id, provider: null }       // disconnect (clears token)
//
// Encrypts the API token using CRED_VAULT_ENC_KEY (same key the password
// vault uses) and writes it to credentials.billing_api_token_enc. We never
// echo the token back — even the safe view returns just a boolean
// `billing_api_connected`.
//
// For Razorpay we pack {key_id, key_secret} into a JSON blob and encrypt the
// whole thing, since both halves are needed to authenticate.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { encrypt } from "../_shared/crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const KNOWN_PROVIDERS = new Set(["stripe", "razorpay", "openai", "anthropic", "aws", "other"]);

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

  let body: { credential_id?: string; provider?: string | null; token?: string; key_id?: string; key_secret?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const credId = (body.credential_id ?? "").trim();
  if (!credId) return json({ error: "credential_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: cred } = await admin.from("credentials").select("id, org_id").eq("id", credId).maybeSingle();
  if (!cred) return json({ error: "credential not found" }, 404);
  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", u.user.id).eq("org_id", cred.org_id);
  if (!mem?.length) return json({ error: "not authorised for this org" }, 403);

  // Disconnect path — null provider clears everything.
  if (body.provider === null) {
    const { error } = await admin.from("credentials").update({
      billing_api_provider: null,
      billing_api_token_enc: null,
      billing_api_last_synced_at: null,
      billing_api_last_sync_error: null,
      billing_api_meta: {},
    }).eq("id", credId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, disconnected: true }, 200);
  }

  const provider = (body.provider ?? "").trim().toLowerCase();
  if (!KNOWN_PROVIDERS.has(provider)) {
    return json({ error: `provider must be one of: ${[...KNOWN_PROVIDERS].join(", ")}` }, 400);
  }

  // Build the secret payload per provider.
  let secret: string;
  if (provider === "razorpay") {
    const keyId = (body.key_id ?? "").trim();
    const keySecret = (body.key_secret ?? "").trim();
    if (!keyId || !keySecret) return json({ error: "razorpay requires key_id and key_secret" }, 400);
    secret = JSON.stringify({ key_id: keyId, key_secret: keySecret });
  } else {
    const token = (body.token ?? "").trim();
    if (!token) return json({ error: "token required" }, 400);
    secret = token;
  }

  let enc: string;
  try {
    enc = await encrypt(secret, "CRED_VAULT_ENC_KEY");
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const { error } = await admin.from("credentials").update({
    billing_api_provider: provider,
    billing_api_token_enc: enc,
    billing_api_last_sync_error: null,
  }).eq("id", credId);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, provider }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
