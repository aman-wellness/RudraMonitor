// POST /functions/v1/manager-assign-reports
// Headers: Authorization: Bearer <user JWT>
// Body: {
//   manager_row_id: 'emp:<uuid>' | 'dir:<uuid>' | '' (clear),
//   report_row_ids: string[]            // each 'emp:<uuid>' or 'dir:<uuid>'
// }
//
// Sets `employees.manager_id` on every supplied report row to the chosen
// manager. Both the manager and any directory-only report rows get their
// employees row created on the fly so the FK can be set.
//
// Returns a per-report outcome array so the UI can render a partial-success
// summary. Use manager_row_id="" to *clear* (unassign) the reports.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface DirRow {
  id: string;
  org_id: string;
  provider: "m365" | "google";
  external_id: string;
  display_name: string | null;
  upn: string | null;
  mail: string | null;
  job_title: string | null;
}

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
  const callerId = u.user.id;

  let body: { manager_row_id?: string; report_row_ids?: string[] };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const managerRowId = (body.manager_row_id ?? "").trim();
  const reportRowIds = Array.isArray(body.report_row_ids) ? body.report_row_ids : [];
  if (!reportRowIds.length) return json({ error: "report_row_ids required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Caller's orgs (membership + owned). Anything outside this set is rejected.
  const [{ data: mem }, { data: ownedOrgs }] = await Promise.all([
    admin.from("org_members").select("org_id").eq("user_id", callerId),
    admin.from("organizations").select("id").eq("owner_user_id", callerId),
  ]);
  const allowedOrgs = new Set<string>([
    ...(mem ?? []).map((r) => r.org_id as string),
    ...(ownedOrgs ?? []).map((r) => r.id as string),
  ]);
  if (allowedOrgs.size === 0) return json({ error: "no org for caller" }, 403);

  // Resolve the manager once. Empty string = clear assignment for every report.
  let managerEmpId: string | null = null;
  let managerOrgId: string | null = null;
  if (managerRowId !== "") {
    try {
      const resolved = await resolveRowToEmployee(admin, managerRowId, callerId);
      managerEmpId = resolved.empId;
      managerOrgId = resolved.orgId;
    } catch (e) {
      return json({ error: `manager: ${(e as Error).message}` }, 400);
    }
    if (managerOrgId && !allowedOrgs.has(managerOrgId)) {
      return json({ error: "manager is in a different org" }, 403);
    }
  }

  const outcomes: Array<{ row_id: string; ok: boolean; employee_id?: string; error?: string }> = [];
  for (const rid of reportRowIds) {
    try {
      const r = await resolveRowToEmployee(admin, rid, callerId);
      if (!allowedOrgs.has(r.orgId)) throw new Error("cross-org assignment forbidden");
      if (managerOrgId && r.orgId !== managerOrgId) throw new Error("report is in a different org than manager");
      if (managerEmpId && r.empId === managerEmpId) throw new Error("can't make a user their own manager");

      const { error: upErr } = await admin
        .from("employees")
        .update({ manager_id: managerEmpId })
        .eq("id", r.empId);
      if (upErr) throw new Error(upErr.message);

      await admin.from("employee_audit").insert({
        org_id: r.orgId, employee_id: r.empId, actor_id: callerId,
        action: managerEmpId ? "manager_assigned" : "manager_cleared",
        detail: { manager_id: managerEmpId },
      });

      outcomes.push({ row_id: rid, ok: true, employee_id: r.empId });
    } catch (e) {
      outcomes.push({ row_id: rid, ok: false, error: (e as Error).message });
    }
  }

  return json({
    manager_employee_id: managerEmpId,
    cleared: managerEmpId === null,
    outcomes,
  }, 200);
});

// ============== helpers ==============

/** Resolve a synthetic v_org_users row_id ('emp:<uuid>' or 'dir:<uuid>') to
 *  a concrete employees row, creating the row lazily for directory-only users. */
async function resolveRowToEmployee(
  admin: ReturnType<typeof createClient>,
  rowId: string,
  callerId: string,
): Promise<{ empId: string; orgId: string }> {
  if (rowId.startsWith("emp:")) {
    const id = rowId.slice(4);
    const { data, error } = await admin.from("employees").select("id, org_id").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("employee not found");
    return { empId: data.id as string, orgId: data.org_id as string };
  }
  if (rowId.startsWith("dir:")) {
    const dirId = rowId.slice(4);
    const { data: dir, error: dirErr } = await admin
      .from("directory_users")
      .select("id, org_id, provider, external_id, display_name, upn, mail, job_title")
      .eq("id", dirId)
      .maybeSingle();
    if (dirErr) throw new Error(dirErr.message);
    if (!dir) throw new Error("directory row not found");
    const d = dir as DirRow;
    const empCol = d.provider === "m365" ? "m365_user_id" : "google_user_id";
    const { data: existing } = await admin
      .from("employees")
      .select("id, org_id")
      .eq("org_id", d.org_id)
      .eq(empCol, d.external_id)
      .maybeSingle();
    if (existing) return { empId: existing.id as string, orgId: existing.org_id as string };
    const { data: created, error: insErr } = await admin
      .from("employees")
      .insert({
        org_id: d.org_id,
        full_name: d.display_name ?? d.upn ?? d.mail ?? d.external_id,
        work_email: d.upn ?? d.mail ?? null,
        designation: d.job_title ?? null,
        status: "active",
        source: "imported",
        [empCol]: d.external_id,
        created_by: callerId,
      })
      .select("id, org_id")
      .single();
    if (insErr) throw new Error(`auto-create: ${insErr.message}`);
    return { empId: created.id as string, orgId: created.org_id as string };
  }
  throw new Error("row_id must start with 'emp:' or 'dir:'");
}

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
