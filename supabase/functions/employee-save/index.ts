// POST /functions/v1/employee-save
// Headers: Authorization: Bearer <user JWT>
// Body (target — one of):
//   { employee_id: string, patch: {...} }
//   { provider: 'm365'|'google', external_id: string, patch: {...} }
//
// Upserts HR-side fields on the employees table. Used by the Employees list
// edit modal to (re)assign managers, departments, designations, etc.
// For directory-synced users that don't yet have an employees row, we lazily
// create one so the FK on credential_assignments / manager_id / offboardings
// can reference it.
//
// Patch fields supported (any subset, all optional):
//   full_name, personal_email, designation, department_id, manager_id,
//   doj, employee_code, status ('active'|'offboarding'|'offboarded').
// work_email is NOT patched here — it comes from the directory and shouldn't
// drift; cloud changes flow back via directory-sync.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_PATCH_FIELDS = new Set([
  "full_name",
  "personal_email",
  "designation",
  "department_id",
  "manager_id",
  "doj",
  "employee_code",
  "status",
]);

// `manager_row_id` is handled specially: it accepts the synthetic id from
// v_org_users ('emp:<uuid>' or 'dir:<uuid>') and resolves it to an actual
// employees.id, lazily creating the manager's employees row if the picked
// user is directory-only. The resolved value lands in patch.manager_id.

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

  let body: { employee_id?: string; provider?: "m365" | "google"; external_id?: string; patch?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const employeeId = (body.employee_id ?? "").trim();
  const provider = body.provider;
  const externalId = (body.external_id ?? "").trim();
  const patch = body.patch ?? {};
  if (!employeeId && !(provider && externalId)) {
    return json({ error: "either employee_id or {provider, external_id} required" }, 400);
  }
  if (typeof patch !== "object") return json({ error: "patch must be an object" }, 400);

  // Whitelist + scrub the patch to the allowed fields. Empty strings become
  // null so dropdowns clearing a value actually persist.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!ALLOWED_PATCH_FIELDS.has(k)) continue;
    clean[k] = v === "" ? null : v;
  }

  // Pull manager_row_id out (not a real column). We resolve it after we know
  // the org so we can validate cross-org access and lazily create the
  // manager's employees row when they're directory-only.
  const managerRowId = typeof patch.manager_row_id === "string" ? patch.manager_row_id.trim() : null;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Locate or create the target employees row.
  let empId = employeeId;
  let orgId: string | null = null;

  if (empId) {
    const { data } = await admin.from("employees").select("id, org_id").eq("id", empId).maybeSingle();
    if (!data) return json({ error: "employee not found" }, 404);
    orgId = data.org_id;
  } else {
    // Directory-only reference. Look up directory_users for the org, then
    // attach (or create) the matching employees row.
    const { data: dir } = await admin
      .from("directory_users")
      .select("org_id, display_name, upn, mail, job_title")
      .eq("provider", provider!)
      .eq("external_id", externalId)
      .maybeSingle();
    if (!dir) return json({ error: "directory user not found" }, 404);
    orgId = dir.org_id as string;
    const empCol = provider === "m365" ? "m365_user_id" : "google_user_id";

    const { data: existing } = await admin
      .from("employees")
      .select("id")
      .eq("org_id", orgId)
      .eq(empCol, externalId)
      .maybeSingle();
    if (existing) {
      empId = existing.id;
    } else {
      const { data: created, error: insErr } = await admin
        .from("employees")
        .insert({
          org_id: orgId,
          full_name: dir.display_name ?? dir.upn ?? dir.mail ?? externalId,
          work_email: dir.upn ?? dir.mail ?? null,
          designation: dir.job_title ?? null,
          status: "active",
          source: "imported",
          [empCol]: externalId,
          created_by: callerId,
        })
        .select("id")
        .single();
      if (insErr) return json({ error: `auto-create: ${insErr.message}` }, 500);
      empId = created.id;
    }
  }

  // Authorise: caller must be in org_members OR the org owner.
  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", callerId).eq("org_id", orgId);
  const { data: ownerRow } = await admin.from("organizations").select("id").eq("id", orgId).eq("owner_user_id", callerId);
  if ((mem?.length ?? 0) === 0 && (ownerRow?.length ?? 0) === 0) {
    return json({ error: "not authorised for this org" }, 403);
  }

  // Resolve manager_row_id ('emp:<uuid>' or 'dir:<uuid>') into a real
  // employees.id, creating the manager's row lazily if needed. An empty
  // string from the UI means "clear the manager" → manager_id becomes null.
  if (managerRowId !== null) {
    if (managerRowId === "") {
      clean.manager_id = null;
    } else if (managerRowId.startsWith("emp:")) {
      clean.manager_id = managerRowId.slice(4);
    } else if (managerRowId.startsWith("dir:")) {
      const dirId = managerRowId.slice(4);
      const { data: dir } = await admin
        .from("directory_users")
        .select("org_id, provider, external_id, display_name, upn, mail, job_title")
        .eq("id", dirId)
        .maybeSingle();
      if (!dir) return json({ error: "manager directory row not found" }, 400);
      if (dir.org_id !== orgId) return json({ error: "manager must be in the same org" }, 400);
      const empCol = dir.provider === "m365" ? "m365_user_id" : "google_user_id";
      const { data: existing } = await admin
        .from("employees")
        .select("id")
        .eq("org_id", orgId)
        .eq(empCol, dir.external_id)
        .maybeSingle();
      if (existing) {
        clean.manager_id = existing.id;
      } else {
        const { data: created, error: insErr } = await admin
          .from("employees")
          .insert({
            org_id: orgId,
            full_name: dir.display_name ?? dir.upn ?? dir.mail ?? dir.external_id,
            work_email: dir.upn ?? dir.mail ?? null,
            designation: dir.job_title ?? null,
            status: "active",
            source: "imported",
            [empCol]: dir.external_id,
            created_by: callerId,
          })
          .select("id")
          .single();
        if (insErr) return json({ error: `auto-create manager row: ${insErr.message}` }, 500);
        clean.manager_id = created.id;
      }
    } else {
      return json({ error: "manager_row_id must start with 'emp:' or 'dir:'" }, 400);
    }
  }

  // If a manager is being set, make sure they belong to the same org and aren't self.
  if (typeof clean.manager_id === "string" && clean.manager_id) {
    if (clean.manager_id === empId) return json({ error: "manager cannot be self" }, 400);
    const { data: mgr } = await admin
      .from("employees")
      .select("org_id")
      .eq("id", clean.manager_id)
      .maybeSingle();
    if (!mgr || mgr.org_id !== orgId) return json({ error: "manager must be in the same org" }, 400);
  }

  if (Object.keys(clean).length === 0) {
    return json({ ok: true, id: empId, message: "no fields to update" }, 200);
  }

  const { error: upErr } = await admin.from("employees").update(clean).eq("id", empId);
  if (upErr) return json({ error: upErr.message }, 500);

  await admin.from("employee_audit").insert({
    org_id: orgId, employee_id: empId, actor_id: callerId,
    action: "edited", target: null,
    detail: { patch: clean },
  });

  return json({ ok: true, id: empId }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
