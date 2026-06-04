// POST /functions/v1/gov-platform-save
// Body: { id?, pillar_id, platform_name, platform_type?, access_method?,
//         ownership_email?, it_registered?, credential_id?, notes?, sort_order? }

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
  const pillarId = (body.pillar_id as string | undefined)?.trim();
  const platformName = (body.platform_name as string | undefined)?.trim();
  if (!id && (!pillarId || !platformName)) {
    return jsonResponse({ error: "pillar_id and platform_name required" }, 400);
  }

  const row: Record<string, unknown> = {
    org_id: orgId,
    platform_name: platformName,
    platform_type: body.platform_type ?? null,
    access_method: body.access_method ?? null,
    ownership_email: body.ownership_email ?? null,
    it_registered: !!body.it_registered,
    credential_id: body.credential_id ?? null,
    notes: body.notes ?? null,
    sort_order: typeof body.sort_order === "number" ? body.sort_order : 100,
  };
  if (pillarId) row.pillar_id = pillarId;

  let result;
  if (id) {
    const { data, error } = await admin
      .from("gov_pillar_platforms").update(row).eq("id", id).eq("org_id", orgId).select().single();
    if (error) return jsonResponse({ error: error.message }, 500);
    result = data;
    await logAudit(admin, orgId, "platform", id, "update", { platform_name: row.platform_name });
  } else {
    const { data, error } = await admin
      .from("gov_pillar_platforms").insert(row).select().single();
    if (error) return jsonResponse({ error: error.message }, 500);
    result = data;
    await logAudit(admin, orgId, "platform", (result as { id: string }).id, "create", { platform_name: row.platform_name });
  }
  return jsonResponse({ ok: true, platform: result });
});
