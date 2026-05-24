// POST /functions/v1/org-subscription-update
// Headers: Authorization: Bearer <user JWT>
// Body: { action: 'enable_em' | 'disable_em' }
//
// Flips the org's Employee Management subscription state. In Phase B we'll
// wire this to Razorpay subscriptions: 'enable_em' will create + confirm a
// $100/mo subscription, 'disable_em' will cancel at period end. For now it
// just flips the DB flag — admins can test the gating without billing live
// yet, and the API surface stays stable for the Razorpay-integrated build.
//
// Owner-only — only the org owner can change billing state.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

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

  let body: { action?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const action = body.action;
  if (action !== "enable_em" && action !== "disable_em") {
    return json({ error: "action must be 'enable_em' or 'disable_em'" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Locate the org owned by the caller.
  const { data: orgs } = await admin.from("organizations").select("id, em_subscribed").eq("owner_user_id", u.user.id).limit(1);
  if (!orgs?.length) return json({ error: "only the org owner can change billing" }, 403);
  const orgId = orgs[0].id as string;

  const patch: Record<string, unknown> = action === "enable_em"
    ? { em_subscribed: true, em_subscribed_since: new Date().toISOString() }
    : { em_subscribed: false };

  const { error } = await admin.from("organizations").update(patch).eq("id", orgId);
  if (error) {
    console.error("org-subscription-update:", error);
    return json({ error: "internal error" }, 500);
  }

  return json({ ok: true, action, em_subscribed: action === "enable_em" }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
