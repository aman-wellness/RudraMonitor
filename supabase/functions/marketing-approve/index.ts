// POST /functions/v1/marketing-approve
// Body: { draft_id: uuid, reject?: boolean }
//
// Super-admin reviewer flips a marketing_drafts row from `pending` →
// `approved` (default) or `rejected` when `reject:true`. Stamps the
// reviewer's user_id + timestamp. Other clients aren't allowed to call
// this because `marketing_drafts_super_read` already gates table reads,
// and we re-verify is_super_admin() server-side here before mutating.

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

  // Server-side super-admin check — the table's RLS gates SELECT but
  // we bypass RLS here with service_role for the UPDATE, so we re-prove
  // the caller is a super admin.
  const { data: superRow } = await admin.rpc("is_super_admin");
  if (!superRow) return json({ error: "super admin required" }, 403);

  let body: { draft_id?: string; reject?: boolean };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.draft_id) return json({ error: "draft_id required" }, 400);

  const isReject = !!body.reject;
  const patch: Record<string, unknown> = isReject
    ? { status: "rejected", rejected_at: new Date().toISOString(), rejected_by: uid }
    : { status: "approved", approved_at: new Date().toISOString(), approved_by: uid };

  const { error } = await admin
    .from("marketing_drafts")
    .update(patch)
    .eq("id", body.draft_id);
  if (error) {
    console.error("marketing-approve update:", error);
    return json({ error: "internal error" }, 500);
  }
  return json({ ok: true, status: isReject ? "rejected" : "approved" });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
