// POST /functions/v1/cred-delete
// Headers: Authorization: Bearer <user JWT>
// Body: { id: uuid }
//
// Hard-deletes a vault credential after verifying the caller's org owns
// it. ON DELETE CASCADE on credential_assignments / credential_invoices
// / credential_requests / credential_request_events cleans up the
// dependents automatically (see migrations 0028 + 0043).
//
// Why an edge function and not a direct client delete via RLS:
//   * Audit row is server-side (the dashboard can't forge `actor_user`).
//   * Same org-scope check pattern as cred-save — one place to maintain.
//   * Keeps the vault key out of the browser path entirely.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

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

  let body: { id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const id = body.id?.trim();
  if (!id) return json({ error: "id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve caller's org. Same pattern as cred-save: only admins / owners
  // of the row's org can delete.
  const { data: mem } = await admin
    .from("org_members").select("org_id, role").eq("user_id", u.user.id).limit(1);
  if (!mem?.length) return json({ error: "no org for caller" }, 403);
  const orgId = mem[0].org_id as string;
  const role = String(mem[0].role ?? "");
  if (!["owner", "admin"].includes(role)) {
    return json({ error: "owner or admin role required" }, 403);
  }

  // Verify the credential belongs to caller's org before deleting.
  const { data: cred } = await admin
    .from("credentials").select("id, org_id, platform_name").eq("id", id).maybeSingle();
  if (!cred) return json({ error: "not found" }, 404);
  if (cred.org_id !== orgId) return json({ error: "not found" }, 404);

  const { error: delErr } = await admin.from("credentials").delete().eq("id", id);
  if (delErr) return json({ error: delErr.message }, 500);

  // Best-effort audit trail. Failures don't roll back the delete; the row
  // is gone either way, but we log the actor for compliance.
  await admin.from("audit_log").insert({
    actor_user: u.user.id,
    actor_role: role === "owner" ? "customer_owner" : "customer_admin",
    action: "credential.delete",
    target_type: "credential",
    target_id: id,
    metadata: { platform_name: cred.platform_name, org_id: orgId },
  });

  return json({ ok: true, id }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
