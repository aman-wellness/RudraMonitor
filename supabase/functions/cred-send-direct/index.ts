// POST /functions/v1/cred-send-direct
// Headers: Authorization: Bearer <user JWT>
// Body: { employee_id: string, credential_ids: string[] }
//
// Admin manually pushes one or more vault credentials to an employee. Each
// credential goes out as a SEPARATE email to keep the audit trail per-platform
// (matches the user's locked decision). Records a credential_assignments row
// per delivery so offboarding can later list everything ever issued to this
// employee.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { sendGraphEmail } from "../_shared/graph-email.ts";
import { getIntegration } from "../_shared/integrations.ts";

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
  const callerId = u.user.id;

  let body: { employee_id?: string; provider?: "m365" | "google"; external_id?: string; credential_ids?: string[] };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const employeeId = body.employee_id;
  const provider = body.provider;
  const externalId = (body.external_id ?? "").trim();
  const credentialIds = Array.isArray(body.credential_ids) ? body.credential_ids : [];
  if (!employeeId && !(provider && externalId)) {
    return json({ error: "either employee_id or {provider, external_id} required" }, 400);
  }
  if (!credentialIds.length) return json({ error: "credential_ids required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve target: existing employees row, or look up directory_users and
  // lazily create a Rudrans employees row so the credential_assignments FK
  // has somewhere to point.
  type EmpRow = { id: string; org_id: string; full_name: string; work_email: string | null; personal_email: string | null; status: string };
  let emp: EmpRow | null = null;

  if (employeeId) {
    const { data } = await admin
      .from("employees")
      .select("id, org_id, full_name, work_email, personal_email, status")
      .eq("id", employeeId)
      .maybeSingle();
    if (!data) return json({ error: "employee not found" }, 404);
    emp = data as EmpRow;
  } else {
    const { data: dir } = await admin
      .from("directory_users")
      .select("org_id, display_name, upn, mail")
      .eq("provider", provider!)
      .eq("external_id", externalId)
      .maybeSingle();
    if (!dir) return json({ error: "directory user not found" }, 404);

    // SECURITY REVIEW M9: authorise BEFORE we may auto-create an employees row
    // for this directory user. Previously the admin gate ran only after the
    // INSERT, so a non-admin could pollute another org's employees table.
    const { data: memD } = await admin
      .from("org_members").select("role").eq("user_id", callerId).eq("org_id", dir.org_id).in("role", ["admin", "owner"]);
    const { data: ownerD } = await admin
      .from("organizations").select("id").eq("id", dir.org_id).eq("owner_user_id", callerId);
    if ((memD?.length ?? 0) === 0 && (ownerD?.length ?? 0) === 0) {
      return json({ error: "admin role required" }, 403);
    }

    const empCol = provider === "m365" ? "m365_user_id" : "google_user_id";
    // Try to find an existing employees row attached to this directory id.
    const { data: existing } = await admin
      .from("employees")
      .select("id, org_id, full_name, work_email, personal_email, status")
      .eq("org_id", dir.org_id)
      .eq(empCol, externalId)
      .maybeSingle();
    if (existing) {
      emp = existing as EmpRow;
    } else {
      // Create a minimal employees row so the assignment can be recorded.
      // status='active' is fine — the user already exists on the provider side.
      const { data: created, error: insErr } = await admin
        .from("employees")
        .insert({
          org_id: dir.org_id,
          full_name: dir.display_name ?? dir.upn ?? dir.mail ?? externalId,
          work_email: dir.upn ?? dir.mail ?? null,
          status: "active",
          source: "imported",
          [empCol]: externalId,
          created_by: callerId,
        })
        .select("id, org_id, full_name, work_email, personal_email, status")
        .single();
      if (insErr) return json({ error: `auto-create employees row: ${insErr.message}` }, 500);
      emp = created as EmpRow;
    }
  }

  // Sending credentials to an employee is destructive (leaks plaintext
  // passwords by email). Gate to org owners + admins only. A plain
  // member with role='member' or 'manager' must NOT be able to call this.
  const { data: mem } = await admin
    .from("org_members")
    .select("role")
    .eq("user_id", callerId)
    .eq("org_id", emp.org_id)
    .in("role", ["admin", "owner"]);
  const { data: ownerRow } = await admin
    .from("organizations")
    .select("id")
    .eq("id", emp.org_id)
    .eq("owner_user_id", callerId);
  if ((mem?.length ?? 0) === 0 && (ownerRow?.length ?? 0) === 0) {
    return json({ error: "admin role required" }, 403);
  }

  if (emp.status !== "active") return json({ error: "employee is not active" }, 400);
  const deliveryEmail = emp.work_email || emp.personal_email;
  if (!deliveryEmail) return json({ error: "user has no email to send to" }, 400);

  // Load each requested credential, decrypt, send a separate email per platform.
  const key = await getIntegration("CRED_VAULT_ENC_KEY");
  if (!key) return json({ error: "CRED_VAULT_ENC_KEY not configured (Admin → Integrations)" }, 500);

  const sent: Array<{ credential_id: string; ok: boolean; error?: string }> = [];
  for (const credId of credentialIds) {
    try {
      const { data: cred } = await admin
        .from("credentials")
        .select("id, org_id, platform_name, login_url, username, notes, active")
        .eq("id", credId)
        .maybeSingle();
      if (!cred || cred.org_id !== emp.org_id) throw new Error("credential not found in org");
      if (!cred.active) throw new Error("credential is inactive");

      const { data: revealed, error: revealErr } = await admin.rpc("cred_reveal", { p_cred_id: credId, p_key: key });
      if (revealErr) throw new Error(`reveal: ${revealErr.message}`);
      const password = revealed as string;

      const mail = await sendGraphEmail({
        orgId: emp.org_id,
        to: deliveryEmail,
        subject: `Account access: ${cred.platform_name}`,
        html: credEmail(emp.full_name, cred.platform_name, cred.login_url, cred.username, password, cred.notes),
      });
      if (!mail.ok) throw new Error(`mail: ${mail.error}`);

      const { error: insErr } = await admin.from("credential_assignments").insert({
        org_id: emp.org_id,
        credential_id: credId,
        employee_id: emp.id,
        request_id: null,
        sent_by: callerId,
        delivery_email: deliveryEmail,
      });
      if (insErr) throw new Error(`assignment insert: ${insErr.message}`);

      sent.push({ credential_id: credId, ok: true });
    } catch (e) {
      sent.push({ credential_id: credId, ok: false, error: (e as Error).message });
    }
  }

  return json({ employee_id: emp.id, sent }, 200);
});

function credEmail(name: string, platform: string, url: string | null, username: string | null, password: string, notes: string | null): string {
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#1f2937">
  <h2 style="color:#0ea5e9;margin:0 0 8px">${escape(platform)} access</h2>
  <p>Hi ${escape(name)},</p>
  <p>Your access to <strong>${escape(platform)}</strong> has been provisioned. Use the credentials below to sign in:</p>
  <table style="border-collapse:collapse;margin:16px 0;background:#f9fafb;padding:12px;border-radius:8px;width:100%">
    ${url ? `<tr><td style="padding:6px 12px;color:#6b7280;width:140px">Sign-in URL</td><td style="padding:6px 12px"><a href="${escape(url)}">${escape(url)}</a></td></tr>` : ""}
    ${username ? `<tr><td style="padding:6px 12px;color:#6b7280">Username</td><td style="padding:6px 12px;font-family:Menlo,monospace"><strong>${escape(username)}</strong></td></tr>` : ""}
    <tr><td style="padding:6px 12px;color:#6b7280">Password</td><td style="padding:6px 12px;font-family:Menlo,monospace"><strong>${escape(password)}</strong></td></tr>
  </table>
  ${notes ? `<p style="font-size:13px;color:#475569"><strong>Notes:</strong> ${escape(notes)}</p>` : ""}
  <p style="font-size:12px;color:#dc2626">If this email is unexpected, notify your IT administrator immediately. Do not forward this email.</p>
</body></html>`;
}
function escape(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}
function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
