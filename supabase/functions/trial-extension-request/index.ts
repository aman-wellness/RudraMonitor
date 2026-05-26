// POST /functions/v1/trial-extension-request
// Body: { reason?: string }
//
// Customer-initiated. An org admin/owner clicks "Request full-features
// trial" in /subscription. We rate-limit to one pending request at a
// time per org. Super admin approves/denies via trial-extension-decide.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) return json({ error: "unauthenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userRes } = await admin.auth.getUser(bearer);
  const uid = userRes?.user?.id;
  if (!uid) return json({ error: "unauthenticated" }, 401);

  let body: { reason?: string };
  try { body = await req.json(); } catch { body = {}; }
  const reason = (body.reason ?? "").trim().slice(0, 1000);

  // Find the caller's org via owner role first, fall back to org_members.
  const { data: member } = await admin
    .from("org_members")
    .select("org_id, role")
    .eq("user_id", uid)
    .in("role", ["owner", "admin"])
    .maybeSingle();
  if (!member) return json({ error: "Only org admins or owners can request a full-features trial." }, 403);
  const orgId = member.org_id;

  // Org must currently be on a plan-scoped trial. If already full_access
  // or paid, refuse.
  const { data: org } = await admin
    .from("organizations")
    .select("id, subscription_status, trial_full_access")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) return json({ error: "Organization not found" }, 404);
  if (org.subscription_status !== "trial") {
    return json({ error: "Full-feature trial requests only apply to trial accounts." }, 400);
  }
  if (org.trial_full_access) {
    return json({ error: "Your org already has full-features trial access." }, 400);
  }

  // One pending request at a time.
  const { data: existing } = await admin
    .from("trial_extension_requests")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .maybeSingle();
  if (existing) {
    return json({ error: "A request is already pending. Please wait for super-admin review." }, 409);
  }

  const { data: row, error } = await admin
    .from("trial_extension_requests")
    .insert({ org_id: orgId, requested_by: uid, reason: reason || null })
    .select("id, requested_at, status")
    .single();
  if (error) return json({ error: `Could not file request: ${error.message}` }, 500);

  await admin.from("audit_log").insert({
    actor_user: uid, actor_role: "customer",
    action: "trial.full_access.request", target_type: "organization", target_id: orgId,
    metadata: { request_id: row.id, reason },
  });

  return json({ ok: true, request: row });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
