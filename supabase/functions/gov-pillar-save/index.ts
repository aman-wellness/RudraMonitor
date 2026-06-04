// POST /functions/v1/gov-pillar-save
// Headers: Authorization: Bearer <user JWT>
// Body: {
//   id?, code, name, color, functions_desc?, reports_to_pillar_id?,
//   hiring_flag?, status?, sort_order?
// }
//
// Create or update a governance pillar. RLS additionally blocks non-writers,
// but we authz here for a clearer 403.

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
  const name = (body.name as string | undefined)?.trim();
  if (!id && (!code || !name)) {
    return jsonResponse({ error: "code and name required for new pillar" }, 400);
  }
  if (code && !/^[a-z0-9-]{1,40}$/.test(code)) {
    return jsonResponse({ error: "code must be lowercase slug (a-z, 0-9, -)" }, 400);
  }

  const row: Record<string, unknown> = {
    org_id: orgId,
    name,
    color: (body.color as string | undefined) ?? "#444444",
    functions_desc: body.functions_desc ?? null,
    reports_to_pillar_id: body.reports_to_pillar_id ?? null,
    hiring_flag: !!body.hiring_flag,
    status: (body.status as string | undefined) ?? "filled",
    sort_order: typeof body.sort_order === "number" ? body.sort_order : 100,
  };
  if (code) row.code = code;

  let result;
  if (id) {
    const { data, error } = await admin
      .from("gov_pillars")
      .update(row)
      .eq("id", id)
      .eq("org_id", orgId)
      .select()
      .single();
    if (error) return jsonResponse({ error: error.message }, 500);
    result = data;
    await logAudit(admin, orgId, "pillar", id, "update", { name: row.name });
  } else {
    const { data, error } = await admin
      .from("gov_pillars")
      .insert(row)
      .select()
      .single();
    if (error) return jsonResponse({ error: error.message }, 500);
    result = data;
    await logAudit(admin, orgId, "pillar", (result as { id: string }).id, "create", { name: row.name });
  }

  return jsonResponse({ ok: true, pillar: result });
});
