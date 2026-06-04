// POST /functions/v1/gov-assignment-save
// Body: {
//   pillar_id,
//   assignments: [{ employee_id, role, is_acting?, notes? }],
//   replace?: boolean   // true = wipe existing assignments for this pillar first
// }
// Bulk-assigns roles. If replace=true, the existing assignment set for the
// pillar is wiped and re-inserted (atomic from the client's view).

import { corsHeaders } from "../_shared/cors.ts";
import { authzWriter, jsonResponse, logAudit } from "../_shared/gov-helpers.ts";

interface AssignmentInput {
  employee_id: string;
  role: 'owner' | 'admin' | 'editor' | 'view' | 'external';
  is_acting?: boolean;
  notes?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const r = await authzWriter(req);
  if (r instanceof Response) return r;
  const { admin, orgId } = r;

  let body: { pillar_id?: string; assignments?: AssignmentInput[]; replace?: boolean };
  try { body = await req.json(); } catch { return jsonResponse({ error: "invalid json" }, 400); }

  const pillarId = (body.pillar_id ?? "").trim();
  if (!pillarId) return jsonResponse({ error: "pillar_id required" }, 400);
  const incoming = Array.isArray(body.assignments) ? body.assignments : [];

  // Validate pillar belongs to caller's org.
  const { data: pillar } = await admin
    .from("gov_pillars").select("id, name").eq("id", pillarId).eq("org_id", orgId).maybeSingle();
  if (!pillar) return jsonResponse({ error: "pillar not found" }, 404);

  if (body.replace) {
    const { error: delErr } = await admin
      .from("gov_pillar_assignments").delete().eq("pillar_id", pillarId).eq("org_id", orgId);
    if (delErr) return jsonResponse({ error: `clear: ${delErr.message}` }, 500);
  }

  if (incoming.length === 0) {
    await logAudit(admin, orgId, "assignment", pillarId, "clear", { pillar_name: pillar.name });
    return jsonResponse({ ok: true, inserted: 0 });
  }

  const VALID_ROLES = new Set(["owner", "admin", "editor", "view", "external"]);
  for (const a of incoming) {
    if (!a.employee_id || !VALID_ROLES.has(a.role)) {
      return jsonResponse({ error: `bad assignment: ${JSON.stringify(a)}` }, 400);
    }
  }

  const rows = incoming.map((a) => ({
    org_id: orgId,
    pillar_id: pillarId,
    employee_id: a.employee_id,
    role: a.role,
    is_acting: !!a.is_acting,
    notes: a.notes ?? null,
  }));

  // Upsert on the unique (pillar_id, employee_id, role) tuple so re-assigning
  // the same person + role + pillar updates `is_acting`/`notes` instead of
  // erroring out.
  const { data, error } = await admin
    .from("gov_pillar_assignments")
    .upsert(rows, { onConflict: "pillar_id,employee_id,role" })
    .select();
  if (error) return jsonResponse({ error: error.message }, 500);

  await logAudit(admin, orgId, "assignment", pillarId, "save", {
    pillar_name: pillar.name,
    count: data?.length ?? 0,
    replace: !!body.replace,
  });
  return jsonResponse({ ok: true, inserted: data?.length ?? 0 });
});
