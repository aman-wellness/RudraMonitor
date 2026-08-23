// POST /functions/v1/delete-employee
// Headers: Authorization: Bearer <user JWT>
// Body (one of):
//   { employee_id: string, delete_cloud_accounts?: boolean }
//   { provider: 'm365'|'google', external_id: string, delete_cloud_accounts?: boolean }
//
// The Employees screen lists both Rudrans-tracked rows AND directory users
// synced from M365/Google. The first variant deletes by Rudrans record id;
// the second deletes by the cloud user's external id (used for rows that
// only exist on the provider side). By default cascade: cloud user goes to
// the provider's "Deleted users" (recoverable 30d on M365, 20d on Google).
// Pass delete_cloud_accounts:false to keep cloud accounts intact.
//
// We use service role to bypass RLS but re-check authorisation explicitly by
// verifying the caller is a member (or owner) of the same org as the target.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { graphFetch, loadOrgM365 } from "../_shared/graph.ts";
import { googleJson, loadOrgGoogle } from "../_shared/google.ts";

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
  const { data: u, error: uErr } = await userClient.auth.getUser();
  if (uErr || !u.user) return json({ error: "invalid token" }, 401);
  const callerId = u.user.id;

  let body: { employee_id?: string; provider?: "m365" | "google"; external_id?: string; delete_cloud_accounts?: boolean };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const employeeId = (body.employee_id ?? "").trim();
  const provider = body.provider;
  const externalId = (body.external_id ?? "").trim();
  const deleteCloud = body.delete_cloud_accounts !== false;   // default true
  if (!employeeId && !(provider && externalId)) {
    return json({ error: "either employee_id or {provider, external_id} required" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve target: load the employees row if employee_id was provided;
  // otherwise look up by directory external id, then attach any matching
  // employees row (may be null — e.g. a user that was synced from M365 but
  // never tracked in Rudrans).
  type EmpRow = { id: string; org_id: string; full_name: string; work_email: string | null; m365_user_id: string | null; google_user_id: string | null };
  let emp: EmpRow | null = null;
  let targetOrgId: string | null = null;
  let m365Target: string | null = null;
  let googleTarget: string | null = null;
  let displayName = "";

  if (employeeId) {
    const { data, error } = await admin
      .from("employees")
      .select("id, org_id, full_name, work_email, m365_user_id, google_user_id")
      .eq("id", employeeId)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: "employee not found" }, 404);
    emp = data as EmpRow;
    targetOrgId = emp.org_id;
    m365Target = emp.m365_user_id;
    googleTarget = emp.google_user_id;
    displayName = emp.full_name;
  } else {
    // Look up the directory row to determine the org and to attach any
    // matching employees row.
    const { data: dirRow, error: dirErr } = await admin
      .from("directory_users")
      .select("org_id, display_name, upn, mail")
      .eq("provider", provider!)
      .eq("external_id", externalId)
      .maybeSingle();
    if (dirErr) return json({ error: dirErr.message }, 500);
    if (!dirRow) return json({ error: "directory user not found" }, 404);
    targetOrgId = dirRow.org_id as string;
    displayName = (dirRow.display_name as string) || (dirRow.upn as string) || (dirRow.mail as string) || externalId;
    if (provider === "m365") m365Target = externalId; else googleTarget = externalId;

    const empCol = provider === "m365" ? "m365_user_id" : "google_user_id";
    const { data: matched } = await admin
      .from("employees")
      .select("id, org_id, full_name, work_email, m365_user_id, google_user_id")
      .eq("org_id", targetOrgId)
      .eq(empCol, externalId)
      .maybeSingle();
    if (matched) emp = matched as EmpRow;
  }

  // Authorise (audit H2): deleting a person — including soft-deleting their
  // Microsoft/Google cloud account — is a destructive admin action, so the
  // caller must be an OWNER or ADMIN of the target org, not merely any member.
  // Previously any org_member (viewer/member/manager) passed this check.
  const { data: mem } = await admin
    .from("org_members")
    .select("org_id, role")
    .eq("user_id", callerId)
    .eq("org_id", targetOrgId)
    .in("role", ["owner", "admin"]);
  const { data: ownerRow } = await admin
    .from("organizations")
    .select("id")
    .eq("id", targetOrgId)
    .eq("owner_user_id", callerId);
  if ((mem?.length ?? 0) === 0 && (ownerRow?.length ?? 0) === 0) {
    return json({ error: "not authorised for this org (owner/admin only)" }, 403);
  }

  const providerResults: Record<string, { ok: boolean; error?: string }> = {};

  // ---- M365: DELETE /users/{id}. The user moves to "Deleted users" in
  //      Microsoft 365 admin center (recoverable for 30 days) — Microsoft's
  //      built-in soft-delete. Treat 404 as already-gone (ok).
  if (deleteCloud && m365Target) {
    try {
      await loadOrgM365(targetOrgId!);
      const r = await graphFetch(targetOrgId!, { method: "DELETE", path: `/users/${m365Target}` });
      if (r.ok || r.status === 204 || r.status === 404) providerResults.m365 = { ok: true };
      else providerResults.m365 = { ok: false, error: `${r.status} ${await r.text()}` };
    } catch (e) {
      providerResults.m365 = { ok: false, error: (e as Error).message };
    }
  }

  // ---- Google: DELETE /users/{id}. Also soft-deletes (recoverable 20 days).
  if (deleteCloud && googleTarget) {
    try {
      await loadOrgGoogle(targetOrgId!);
      await googleJson(targetOrgId!, { method: "DELETE", path: `/users/${googleTarget}` });
      providerResults.google = { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      if (/404|not found/i.test(msg)) providerResults.google = { ok: true };
      else providerResults.google = { ok: false, error: msg };
    }
  }

  // ---- Also remove from the directory_users mirror so the UI updates
  //      immediately without waiting for the next sync.
  if (m365Target) {
    await admin.from("directory_users").delete()
      .eq("org_id", targetOrgId!).eq("provider", "m365").eq("external_id", m365Target);
  }
  if (googleTarget) {
    await admin.from("directory_users").delete()
      .eq("org_id", targetOrgId!).eq("provider", "google").eq("external_id", googleTarget);
  }

  // ---- Rudrans-side employees row, if one exists for this person.
  if (emp) {
    const { error: delErr } = await admin.from("employees").delete().eq("id", emp.id);
    if (delErr) return json({ error: delErr.message, providers: providerResults }, 500);
  }

  await admin.from("employee_audit").insert({
    org_id: targetOrgId!, employee_id: null, actor_id: callerId,
    action: "deleted",
    target: emp?.work_email ?? displayName,
    detail: {
      deleted_employee_id: emp?.id ?? null,
      external_id: externalId || null,
      provider: provider ?? null,
      full_name: displayName,
      providers: providerResults,
    },
  });

  return json({
    ok: true,
    deleted_id: emp?.id ?? null,
    deleted_name: displayName,
    providers: providerResults,
  }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
