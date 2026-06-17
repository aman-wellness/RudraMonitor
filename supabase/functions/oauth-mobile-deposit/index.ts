// POST /functions/v1/oauth-mobile-deposit
// Body: { state, code }
//
// Called by the static bridge page (oauth-bridge.html) right after the
// OAuth provider redirects back. The bridge runs in whatever external
// browser the OS chose to handle the Custom Tab; that browser cannot
// reliably hand a deep-link URL to our Capacitor app (verified via
// adb logcat on OnePlus / HeyTapBrowser — the app foregrounds without
// ever receiving an appUrlOpen event). So instead the bridge POSTs the
// one-shot PKCE `code` here keyed by `state`, and the mobile app polls
// the retrieve endpoint on resume.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { state?: string; code?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const state = (body.state ?? "").trim();
  const code = (body.code ?? "").trim();
  if (!state || !code) return json({ error: "state and code required" }, 400);
  // Implicit-flow tokens from Microsoft are commonly 6-8 KB once the
  // provider_token (full Graph API access token) is included. The old
  // 5 KB ceiling was sized for PKCE codes (~100 chars) — way too tight
  // for the IMPLICIT:{...} JSON bundle. 32 KB is safely above what any
  // identity provider emits and still cheap to store/transmit.
  if (state.length > 200 || code.length > 32768) return json({ error: "payload too large" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Upsert on state so retries of the same OAuth flow don't error.
  const { error } = await admin
    .from("oauth_mobile_handoff")
    .upsert({ state, code, created_at: new Date().toISOString() }, { onConflict: "state" });
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
