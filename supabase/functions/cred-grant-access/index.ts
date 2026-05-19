// POST /functions/v1/cred-grant-access
// Headers: Authorization: Bearer <user JWT>
// Body:    { credential_ids: string[], employee_ids: string[], group_ids?: string[], send_now?: boolean }
//
// Grants vault access to a set of employees (optionally expanded from group
// memberships) for one or more credentials. Inserts credential_assignments
// rows but does NOT email the password — the customer can later use the
// "Send to user" action on the Vault tab to dispatch. If `send_now` is true,
// we call the existing cred-send-direct flow inside the same request.
//
// Owner / Org Admin only.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { resolveWriterOrgId } from "../_shared/auth-org.ts";

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

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const orgId = await resolveWriterOrgId(admin, u.user.id);
  if (!orgId) return json({ error: "only org owner or admin can grant credential access" }, 403);

  let body: { credential_ids?: string[]; employee_ids?: string[]; group_ids?: string[] };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const credIds = Array.isArray(body.credential_ids) ? body.credential_ids.filter(Boolean) : [];
  const empIds  = new Set(Array.isArray(body.employee_ids)  ? body.employee_ids.filter(Boolean)  : []);
  const grpIds  = Array.isArray(body.group_ids) ? body.group_ids.filter(Boolean) : [];
  if (credIds.length === 0) return json({ error: "credential_ids required" }, 400);

  // Expand each group into its member employees (matched by UPN / work_email
  // in the directory mirror). This way the customer can grant a whole team
  // access to a vault entry in one click.
  if (grpIds.length > 0) {
    const { data: members } = await admin
      .from("directory_group_members")
      .select("group_id, external_user_id, directory_users!inner(upn, mail)")
      .in("group_id", grpIds);

    type MemberRow = { external_user_id: string; directory_users: { upn: string | null; mail: string | null } | null };
    const upns = ((members ?? []) as MemberRow[])
      .map((m) => m.directory_users?.upn ?? m.directory_users?.mail ?? null)
      .filter((u): u is string => !!u)
      .map((u) => u.toLowerCase());
    if (upns.length > 0) {
      const { data: emps } = await admin
        .from("employees")
        .select("id, work_email")
        .eq("org_id", orgId)
        .not("work_email", "is", null);
      for (const e of (emps ?? []) as Array<{ id: string; work_email: string }>) {
        if (upns.includes(e.work_email.toLowerCase())) empIds.add(e.id);
      }
    }
  }

  if (empIds.size === 0) return json({ error: "no employees resolved — pick employees or a non-empty group" }, 400);

  // Validate credentials + employees belong to the caller's org so an admin
  // can't grant another tenant's vault to their own users.
  const { data: validCreds } = await admin
    .from("credentials")
    .select("id")
    .eq("org_id", orgId)
    .in("id", credIds);
  const okCredIds = new Set((validCreds ?? []).map((c: { id: string }) => c.id));

  const { data: validEmps } = await admin
    .from("employees")
    .select("id, work_email, personal_email")
    .eq("org_id", orgId)
    .in("id", Array.from(empIds));
  const empById = new Map((validEmps ?? []).map((e: { id: string; work_email: string | null; personal_email: string | null }) => [e.id, e]));

  if (okCredIds.size === 0 || empById.size === 0) {
    return json({ error: "no valid credential / employee combos for this org" }, 403);
  }

  // Idempotent insert: skip pairs that already have an active (non-revoked)
  // assignment row.
  const { data: existing } = await admin
    .from("credential_assignments")
    .select("credential_id, employee_id")
    .in("credential_id", Array.from(okCredIds))
    .in("employee_id", Array.from(empById.keys()))
    .is("revoked_at", null);
  const existsKey = new Set(
    ((existing ?? []) as Array<{ credential_id: string; employee_id: string }>)
      .map((r) => `${r.credential_id}|${r.employee_id}`),
  );

  const now = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (const credId of okCredIds) {
    for (const [empId, emp] of empById) {
      if (existsKey.has(`${credId}|${empId}`)) continue;
      rows.push({
        org_id: orgId,
        credential_id: credId,
        employee_id: empId,
        sent_at: now,
        sent_by: u.user.id,
        delivery_email: emp.work_email ?? emp.personal_email ?? "",
      });
    }
  }

  let inserted = 0;
  if (rows.length > 0) {
    const { error } = await admin.from("credential_assignments").insert(rows);
    if (error) return json({ error: error.message }, 500);
    inserted = rows.length;
  }

  return json({
    ok: true,
    inserted,
    skipped_existing: (existsKey.size > 0) ? existsKey.size : 0,
    credentials: okCredIds.size,
    employees: empById.size,
  }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
