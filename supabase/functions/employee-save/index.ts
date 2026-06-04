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
import { graphTokenFor } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const ALLOWED_PATCH_FIELDS = new Set([
  "full_name",
  "personal_email",
  "designation",
  "department_id",
  "manager_id",
  "doj",
  "employee_code",
  "status",
  // M365 "Manage contact information" parity (migration 0098). All optional.
  "office_location",
  "office_phone",
  "fax_number",
  "mobile_phone",
  "street_address",
  "city",
  "state_province",
  "postal_code",
  "country",
]);

// Mapping employees-column → Graph user property. Used when we mirror an
// employees patch up to Microsoft 365. Keep in sync with the columns added
// in migration 0098. `office_phone` is special — Graph stores phone numbers
// as `businessPhones: string[]`, so we send a one-element array.
const GRAPH_FIELD_MAP: Record<string, string> = {
  full_name:        "displayName",
  designation:      "jobTitle",
  office_location:  "officeLocation",
  fax_number:       "faxNumber",
  mobile_phone:     "mobilePhone",
  street_address:   "streetAddress",
  city:             "city",
  state_province:   "state",
  postal_code:      "postalCode",
  country:          "country",
};

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
  }

  // SECURITY: authorise BEFORE any insert. The previous order created the
  // employees row first when resolving by {provider, external_id}, which
  // allowed a caller who knew (or brute-forced) a victim org's external_id
  // to seed ghost employees in that org before the authz check rejected
  // them. Caller must be the org owner OR an org_members row with a
  // writer role (owner / admin / manager). Regular `user` members are
  // read-only and may not edit HR fields.
  const { data: ownerRow } = await admin.from("organizations").select("id").eq("id", orgId).eq("owner_user_id", callerId).maybeSingle();
  const isOwner = !!ownerRow;
  const { data: mem } = await admin
    .from("org_members")
    .select("role")
    .eq("user_id", callerId)
    .eq("org_id", orgId)
    .maybeSingle();
  const memberRole = (mem?.role ?? "").toLowerCase();
  const WRITER_ROLES = new Set(["owner", "admin", "manager"]);
  if (!isOwner && !mem) {
    return json({ error: "not authorised for this org" }, 403);
  }
  if (!isOwner && !WRITER_ROLES.has(memberRole)) {
    return json({ error: "your role does not allow editing employees" }, 403);
  }

  // Resolve/create the employees row now that authz is established.
  if (!empId) {
    const { data: dir } = await admin
      .from("directory_users")
      .select("display_name, upn, mail, job_title")
      .eq("provider", provider!)
      .eq("external_id", externalId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!dir) return json({ error: "directory user not found" }, 404);
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

  // Mirror the patch up to Microsoft 365 SYNCHRONOUSLY so the UI knows
  // whether the M365 write succeeded. Previously this was fire-and-forget
  // (queueBackground), which caused silent failures — the customer saw
  // "saved" in our portal but M365 still showed the old data. Errors are
  // surfaced as a non-fatal warning so the local save still sticks.
  console.info(`[employee-save] starting M365 mirror for emp=${empId} fields=${Object.keys(clean).join(',')}`);
  let m365Status: { ok: boolean; warnings?: string[]; debug?: unknown } = { ok: true };
  try {
    const warnings = await mirrorToGraph(admin, orgId!, empId, clean);
    console.info(`[employee-save] M365 mirror complete for ${empId} — warnings=${warnings.length}`);
    if (warnings.length > 0) {
      for (const w of warnings) console.warn(`[employee-save] M365 warning: ${w}`);
      m365Status = { ok: false, warnings };
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[employee-save] m365 mirror for ${empId} threw: ${msg}\n${(e as Error).stack ?? ''}`);
    m365Status = { ok: false, warnings: [msg] };
  }

  return json({
    ok: true,
    id: empId,
    m365: m365Status,
  }, 200);
});

async function mirrorToGraph(
  admin: ReturnType<typeof createClient>,
  orgId: string,
  empId: string,
  patch: Record<string, unknown>,
): Promise<string[]> {
  const warnings: string[] = [];
  console.info(`[mirrorToGraph] called for empId=${empId} patch_keys=[${Object.keys(patch).join(',')}]`);

  // Need the m365_user_id to push anything. Also pull the (possibly-just-set)
  // manager_id so we can resolve the manager's m365_user_id for the $ref PUT.
  const { data: row } = await admin
    .from("employees")
    .select("m365_user_id, manager_id, department_id")
    .eq("id", empId).maybeSingle();
  const emp = row as { m365_user_id: string | null; manager_id: string | null; department_id: string | null } | null;
  console.info(`[mirrorToGraph] DB row: m365_user_id=${emp?.m365_user_id ?? 'NULL'} manager_id=${emp?.manager_id ?? 'NULL'}`);
  if (!emp?.m365_user_id) {
    warnings.push("Employee has no m365_user_id — not linked to M365, can't push");
    return warnings;
  }

  // Build the Graph PATCH body from the subset of patched columns Graph
  // actually accepts. department is special: locally we store department_id
  // (FK), Graph wants the human department NAME.
  const graphBody: Record<string, unknown> = {};
  for (const [col, val] of Object.entries(patch)) {
    if (col === "department_id") continue;        // handled below
    if (col === "office_phone")  continue;        // handled below (array shape)
    if (col === "manager_id")    continue;        // handled below (separate $ref endpoint)
    const graphKey = GRAPH_FIELD_MAP[col];
    if (graphKey) graphBody[graphKey] = val ?? null;
  }
  // Department name lookup.
  if ("department_id" in patch) {
    if (!patch.department_id) graphBody.department = null;
    else {
      const { data: dept } = await admin.from("org_departments").select("name").eq("id", patch.department_id).maybeSingle();
      graphBody.department = (dept as { name?: string } | null)?.name ?? null;
    }
  }
  // Phone array.
  if ("office_phone" in patch) {
    const p = (patch.office_phone as string | null | undefined);
    graphBody.businessPhones = p ? [p] : [];
  }

  let accessToken: string;
  try {
    const tok = await graphTokenFor(orgId);
    accessToken = tok.accessToken;
  } catch (e) {
    warnings.push(`M365 token: ${(e as Error).message}`);
    return warnings;
  }

  // ── PATCH profile fields ──
  if (Object.keys(graphBody).length > 0) {
    try {
      const r = await fetch(`${GRAPH_BASE}/users/${emp.m365_user_id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(graphBody),
      });
      if (!r.ok) {
        const body = await r.text();
        warnings.push(`Profile PATCH failed: ${r.status} ${body.slice(0, 200)}`);
      } else {
        console.info(`[employee-save] M365 profile PATCHed for ${emp.m365_user_id}`);
      }
    } catch (e) {
      warnings.push(`Profile PATCH network error: ${(e as Error).message}`);
    }
  }

  // ── Manager $ref ──  separate endpoint, separate failure mode.
  if ("manager_id" in patch) {
    if (!emp.manager_id) {
      // Clear manager.
      try {
        const r = await fetch(`${GRAPH_BASE}/users/${emp.m365_user_id}/manager/$ref`, {
          method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!r.ok && r.status !== 404) {
          warnings.push(`Manager DELETE failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
        } else {
          console.info(`[employee-save] M365 manager cleared for ${emp.m365_user_id}`);
        }
      } catch (e) {
        warnings.push(`Manager DELETE network error: ${(e as Error).message}`);
      }
    } else {
      const { data: mgrRow } = await admin
        .from("employees")
        .select("m365_user_id, full_name")
        .eq("id", emp.manager_id).maybeSingle();
      const mgr = mgrRow as { m365_user_id: string | null; full_name: string } | null;
      if (!mgr?.m365_user_id) {
        warnings.push(`Manager "${mgr?.full_name ?? "(unknown)"}" has no M365 link — local-only assignment, not pushed to M365`);
      } else {
        try {
          const r = await fetch(`${GRAPH_BASE}/users/${emp.m365_user_id}/manager/$ref`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ "@odata.id": `${GRAPH_BASE}/users/${mgr.m365_user_id}` }),
          });
          if (!r.ok) {
            warnings.push(`Manager PUT failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
          } else {
            console.info(`[employee-save] M365 manager set: ${emp.m365_user_id} → ${mgr.m365_user_id}`);
          }
        } catch (e) {
          warnings.push(`Manager PUT network error: ${(e as Error).message}`);
        }
      }
      // If manager has no m365_user_id (manager is a local-only Rudrans
      // record), there's nothing to write to Graph — local manager_id is
      // still useful for the Rudrans org chart, but it won't appear in M365.
    }
  }

  return warnings;
}

function queueBackground(fn: () => Promise<unknown>): void {
  const p = fn();
  // deno-lint-ignore no-explicit-any
  if (typeof (globalThis as any).EdgeRuntime !== "undefined" && (globalThis as any).EdgeRuntime?.waitUntil) {
    (globalThis as any).EdgeRuntime.waitUntil(p);
  }
}

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
