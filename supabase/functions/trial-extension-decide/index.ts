// POST /functions/v1/trial-extension-decide
// Body: { request_id: uuid, decision: 'approved' | 'denied', note?: string }
//
// Super-admin only. Resolves a pending trial_extension_request. On
// approval we also flip organizations.trial_full_access=true so
// org_effective_features() starts returning the full feature set
// immediately (no client refresh needed beyond the next RPC call).

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

  // is_super_admin() relies on auth.uid(), which is NULL under the
  // service-role client used here — so query the role directly.
  const { data: roleRow } = await admin
    .from("app_users").select("app_role").eq("user_id", uid).maybeSingle();
  if (roleRow?.app_role !== "super_admin") return json({ error: "super admin required" }, 403);

  let body: { request_id?: string; decision?: string; note?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.request_id) return json({ error: "request_id required" }, 400);
  if (body.decision !== "approved" && body.decision !== "denied") {
    return json({ error: "decision must be 'approved' or 'denied'" }, 400);
  }
  const note = (body.note ?? "").trim().slice(0, 1000) || null;

  const { data: reqRow } = await admin
    .from("trial_extension_requests")
    .select("id, org_id, status, kind, days_requested")
    .eq("id", body.request_id)
    .maybeSingle();
  if (!reqRow) return json({ error: "request not found" }, 404);
  if (reqRow.status !== "pending") {
    return json({ error: `request already ${reqRow.status}` }, 409);
  }

  if (body.decision === "approved") {
    if (reqRow.kind === "time_extension") {
      // RPC handles status update + audit log atomically.
      const { error: rpcErr } = await admin.rpc("approve_trial_time_extension", {
        p_request_id: body.request_id,
        p_super_admin_id: uid,
        p_decision_note: note,
      });
      if (rpcErr) return json({ error: `approve_trial_time_extension: ${rpcErr.message}` }, 500);
      return json({ ok: true, kind: reqRow.kind, days: reqRow.days_requested });
    }
    // feature_access: flip the flag.
    const { error: orgErr } = await admin
      .from("organizations")
      .update({ trial_full_access: true })
      .eq("id", reqRow.org_id);
    if (orgErr) return json({ error: `Approved but org flip failed: ${orgErr.message}` }, 500);
  }

  const { error: updErr } = await admin
    .from("trial_extension_requests")
    .update({
      status: body.decision,
      decided_by: uid,
      decided_at: new Date().toISOString(),
      decision_note: note,
    })
    .eq("id", body.request_id);
  if (updErr) return json({ error: `Could not update request: ${updErr.message}` }, 500);

  await admin.from("audit_log").insert({
    actor_user: uid, actor_role: "super_admin",
    action: `trial.${reqRow.kind}.${body.decision}`,
    target_type: "organization", target_id: reqRow.org_id,
    metadata: { request_id: body.request_id, note, kind: reqRow.kind },
  });

  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
