// POST /functions/v1/gov-pillar-delete
// Body: { id }
// Removes pillar + cascades to assignments + platforms + channel.primary_pillar_id

import { corsHeaders } from "../_shared/cors.ts";
import { authzWriter, jsonResponse, logAudit } from "../_shared/gov-helpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const r = await authzWriter(req);
  if (r instanceof Response) return r;
  const { admin, orgId } = r;

  let body: { id?: string };
  try { body = await req.json(); } catch { return jsonResponse({ error: "invalid json" }, 400); }
  const id = (body.id ?? "").trim();
  if (!id) return jsonResponse({ error: "id required" }, 400);

  // Capture name for audit before delete.
  const { data: existing } = await admin
    .from("gov_pillars").select("name").eq("id", id).eq("org_id", orgId).maybeSingle();

  const { error } = await admin.from("gov_pillars").delete().eq("id", id).eq("org_id", orgId);
  if (error) return jsonResponse({ error: error.message }, 500);

  await logAudit(admin, orgId, "pillar", id, "delete", { name: existing?.name ?? null });
  return jsonResponse({ ok: true });
});
