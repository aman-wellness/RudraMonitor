// POST /functions/v1/gov-access-register-save
// Body — two modes:
//   1. Upsert rows: { rows: [{id?, platform_id, employee_id?, role_label,
//                              email_format?, access_level, notes?, sort_order?}] }
//   2. Mark reviewed: { row_ids: [uuid...], mark_reviewed: true }
//
// Mark-reviewed sets last_reviewed_at = now() and last_reviewed_by = caller.

import { corsHeaders } from "../_shared/cors.ts";
import { authzWriter, jsonResponse, logAudit } from "../_shared/gov-helpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const r = await authzWriter(req);
  if (r instanceof Response) return r;
  const { admin, userId, orgId } = r;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return jsonResponse({ error: "invalid json" }, 400); }

  // ── Mode 2: mark reviewed
  if (body.mark_reviewed === true && Array.isArray(body.row_ids)) {
    const ids = body.row_ids as string[];
    if (ids.length === 0) return jsonResponse({ ok: true, reviewed: 0 });
    const { error } = await admin
      .from("gov_access_register")
      .update({ last_reviewed_at: new Date().toISOString(), last_reviewed_by: userId })
      .eq("org_id", orgId)
      .in("id", ids);
    if (error) return jsonResponse({ error: error.message }, 500);
    await logAudit(admin, orgId, "access_register", null, "review", { count: ids.length });
    return jsonResponse({ ok: true, reviewed: ids.length });
  }

  // ── Mode 1: upsert rows
  const incoming = Array.isArray(body.rows) ? body.rows as Record<string, unknown>[] : [];
  if (incoming.length === 0) return jsonResponse({ error: "rows array required" }, 400);

  const VALID_LEVELS = new Set(["owner", "admin", "editor", "view", "external"]);
  let updated = 0;
  let created = 0;
  for (const raw of incoming) {
    if (!raw.platform_id || !raw.role_label || !VALID_LEVELS.has(raw.access_level as string)) {
      return jsonResponse({ error: `bad row: ${JSON.stringify(raw)}` }, 400);
    }
    const row = {
      org_id: orgId,
      platform_id: raw.platform_id as string,
      employee_id: (raw.employee_id as string | undefined) ?? null,
      role_label: raw.role_label as string,
      email_format: (raw.email_format as string | undefined) ?? null,
      access_level: raw.access_level as string,
      notes: (raw.notes as string | undefined) ?? null,
      sort_order: typeof raw.sort_order === "number" ? raw.sort_order : 100,
    };
    if (raw.id) {
      const { error } = await admin
        .from("gov_access_register").update(row).eq("id", raw.id as string).eq("org_id", orgId);
      if (error) return jsonResponse({ error: error.message }, 500);
      updated++;
    } else {
      const { error } = await admin.from("gov_access_register").insert(row);
      if (error) return jsonResponse({ error: error.message }, 500);
      created++;
    }
  }

  await logAudit(admin, orgId, "access_register", null, "save", { updated, created });
  return jsonResponse({ ok: true, updated, created });
});
