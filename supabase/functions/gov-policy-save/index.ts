// POST /functions/v1/gov-policy-save
// Body: { id?, code, body, enforced_by?, sort_order?, is_active? }

import { corsHeaders } from "../_shared/cors.ts";
import { authzWriter, jsonResponse, logAudit } from "../_shared/gov-helpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const r = await authzWriter(req);
  if (r instanceof Response) return r;
  const { admin, orgId } = r;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return jsonResponse({ error: "invalid json" }, 400); }

  const id = (body.id as string | undefined) ?? null;
  const code = (body.code as string | undefined)?.trim();
  const text = (body.body as string | undefined)?.trim();
  if (!id && (!code || !text)) return jsonResponse({ error: "code and body required" }, 400);

  const row: Record<string, unknown> = {
    org_id: orgId,
    body: text,
    enforced_by: body.enforced_by ?? null,
    sort_order: typeof body.sort_order === "number" ? body.sort_order : 100,
    is_active: typeof body.is_active === "boolean" ? body.is_active : true,
  };
  if (code) row.code = code;

  let result;
  if (id) {
    const { data, error } = await admin
      .from("gov_policies").update(row).eq("id", id).eq("org_id", orgId).select().single();
    if (error) return jsonResponse({ error: error.message }, 500);
    result = data;
    await logAudit(admin, orgId, "policy", id, "update", { code: row.code });
  } else {
    const { data, error } = await admin
      .from("gov_policies").insert(row).select().single();
    if (error) return jsonResponse({ error: error.message }, 500);
    result = data;
    await logAudit(admin, orgId, "policy", (result as { id: string }).id, "create", { code: row.code });
  }
  return jsonResponse({ ok: true, policy: result });
});
