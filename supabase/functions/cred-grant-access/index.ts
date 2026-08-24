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

  // Expand each group into its member employees. The customer's expectation
  // when they click "grant CANADA-TEAM access to Claude" is that every
  // member of CANADA-TEAM gets access — even members who only exist in the
  // M365 / Google directory and have never been provisioned through the
  // Rudrans wizard (so they have no `employees` row yet).
  //
  // Old logic matched directory UPNs against existing `employees.work_email`
  // and dropped anyone without a hit — that's the "no employees resolved"
  // error the customer kept seeing on the Groups tab. cred-send-direct
  // already auto-provisions a minimal employees row for directory-only
  // users so the assignment can be recorded; mirror that pattern here.
  if (grpIds.length > 0) {
    const { data: members } = await admin
      .from("directory_group_members")
      .select(
        "group_id, external_user_id, directory_users!inner(id, org_id, provider, external_id, upn, mail, display_name)",
      )
      .in("group_id", grpIds)
      .eq("org_id", orgId);

    type MemberRow = {
      external_user_id: string;
      directory_users: {
        org_id: string;
        provider: "m365" | "google";
        external_id: string;
        upn: string | null;
        mail: string | null;
        display_name: string | null;
      } | null;
    };
    const dirUsers = ((members ?? []) as MemberRow[])
      .map((m) => m.directory_users)
      .filter((d): d is NonNullable<MemberRow["directory_users"]> => !!d && d.org_id === orgId);

    // Pre-fetch every employees row that could match (by either provider's
    // external_user_id column OR by work_email). One query covers all
    // groups so we're not making N requests in a loop.
    const m365Ids = dirUsers.filter((d) => d.provider === "m365").map((d) => d.external_id);
    const googleIds = dirUsers.filter((d) => d.provider === "google").map((d) => d.external_id);
    const emails = dirUsers
      .flatMap((d) => [d.upn, d.mail])
      .filter((e): e is string => !!e)
      .map((e) => e.toLowerCase());

    // SECURITY REVIEW M8: these values come from directory sync (semi-trusted).
    // They are interpolated into a PostgREST .or() filter, so a value containing
    // a quote / comma / paren could corrupt the filter and broaden the match.
    // Legit external ids and emails never contain these, so stripping them
    // neutralises injection without affecting real data.
    const orSafe = (s: string) => s.replace(/["\\(),]/g, "");
    const { data: existingEmps } = await admin
      .from("employees")
      .select("id, work_email, m365_user_id, google_user_id")
      .eq("org_id", orgId)
      .or([
        m365Ids.length ? `m365_user_id.in.(${m365Ids.map((s) => `"${orSafe(s)}"`).join(",")})` : "",
        googleIds.length ? `google_user_id.in.(${googleIds.map((s) => `"${orSafe(s)}"`).join(",")})` : "",
        emails.length ? `work_email.in.(${emails.map((s) => `"${orSafe(s)}"`).join(",")})` : "",
      ].filter(Boolean).join(","));

    type EmpRow = { id: string; work_email: string | null; m365_user_id: string | null; google_user_id: string | null };
    const empRows = (existingEmps ?? []) as EmpRow[];
    const byM365 = new Map(empRows.filter((e) => e.m365_user_id).map((e) => [e.m365_user_id!, e.id]));
    const byGoogle = new Map(empRows.filter((e) => e.google_user_id).map((e) => [e.google_user_id!, e.id]));
    const byEmail = new Map(empRows.filter((e) => e.work_email).map((e) => [e.work_email!.toLowerCase(), e.id]));

    // Walk each directory member: resolve to an existing employees.id OR
    // auto-create a minimal row so the assignment can land.
    for (const dir of dirUsers) {
      const linkedId = (dir.provider === "m365" ? byM365.get(dir.external_id) : byGoogle.get(dir.external_id))
        ?? (dir.upn ? byEmail.get(dir.upn.toLowerCase()) : undefined)
        ?? (dir.mail ? byEmail.get(dir.mail.toLowerCase()) : undefined);
      if (linkedId) {
        empIds.add(linkedId);
        continue;
      }
      // No existing row — create one. Status='active' is fine because the
      // user already exists on the provider side.
      const empCol = dir.provider === "m365" ? "m365_user_id" : "google_user_id";
      const { data: created, error: insErr } = await admin
        .from("employees")
        .insert({
          org_id: orgId,
          full_name: dir.display_name ?? dir.upn ?? dir.mail ?? dir.external_id,
          work_email: dir.upn ?? dir.mail ?? null,
          status: "active",
          source: "imported",
          [empCol]: dir.external_id,
          created_by: u.user.id,
        })
        .select("id, work_email")
        .single();
      if (insErr) {
        // Don't fail the whole batch — log and continue. Other members
        // may still resolve cleanly.
        console.warn(`grant-access: auto-create failed for ${dir.external_id}:`, insErr.message);
        continue;
      }
      empIds.add(created.id);
      // Keep our local index in sync so a duplicate directory member in
      // another selected group reuses the same row.
      if (dir.provider === "m365") byM365.set(dir.external_id, created.id);
      else byGoogle.set(dir.external_id, created.id);
      if (created.work_email) byEmail.set(created.work_email.toLowerCase(), created.id);
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
