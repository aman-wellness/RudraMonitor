// POST /functions/v1/provision-employee
// Headers: Authorization: Bearer <user JWT>
// Body: {
//   full_name: string,
//   personal_email?: string,
//   mail_nickname: string,                  // local-part of work_email (before @)
//   primary_domain?: string,                // fallback to org_integrations.primary_domain
//   given_name?, surname?, designation?,
//   department_id?: string,
//   manager_id?: string,                    // employees.id, used for cc on welcome mail
//   doj?: 'YYYY-MM-DD',
//   employee_code?: string,
//   create_m365?: boolean,                  // default true if M365 connected
//   create_google?: boolean,                // default true if Google connected
//   m365_usage_location?: string,           // e.g. 'IN'; required by Graph if assigning licenses
//   m365_license_skus?: string[],           // SkuId GUIDs to assign
// }
//
// Flow:
//   1. Auth + org resolution.
//   2. Generate a strong temporary password (returned only inside the email).
//   3. Create M365 user via Graph if requested+connected — capture m365_user_id.
//   4. Optionally assign M365 licenses (best-effort; non-fatal if missing).
//   5. Create Google user if requested+connected — capture google_user_id.
//   6. Insert `employees` row + audit log.
//   7. Mail temp password to personal_email (cc manager).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { graphJson, loadOrgM365 } from "../_shared/graph.ts";
import { googleJson, loadOrgGoogle } from "../_shared/google.ts";
import { sendGraphEmail } from "../_shared/graph-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface Body {
  full_name?: string; display_name?: string;
  personal_email?: string;
  mail_nickname?: string; primary_domain?: string;
  given_name?: string; surname?: string; designation?: string;
  department_id?: string; manager_id?: string;
  doj?: string; employee_code?: string;
  create_m365?: boolean; create_google?: boolean;
  m365_usage_location?: string; m365_license_skus?: string[];
  manual_password?: string;              // if provided, used instead of auto-generated
  force_change_password?: boolean;        // default true
  return_password?: boolean;              // include the temp password in the response (for show-on-finish UX)
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

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const fullName = (body.full_name ?? "").trim();
  const mailNick = (body.mail_nickname ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!fullName) return json({ error: "full_name required" }, 400);
  if (!mailNick) return json({ error: "mail_nickname required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve caller's org (owner OR org admin).
  const { resolveWriterOrgId } = await import("../_shared/auth-org.ts");
  const orgId = await resolveWriterOrgId(admin, callerId);
  if (!orgId) return json({ error: "no org for caller — only owners or org admins can provision" }, 403);

  // Determine domain to use for UPN.
  const wantM365 = body.create_m365 !== false;
  const wantGoogle = body.create_google !== false;
  let domain = (body.primary_domain ?? "").trim().toLowerCase();
  let m365Conn: Awaited<ReturnType<typeof loadOrgM365>> | null = null;
  let googleConn: Awaited<ReturnType<typeof loadOrgGoogle>> | null = null;
  let m365LoadError: string | null = null;
  let googleLoadError: string | null = null;
  try { m365Conn = await loadOrgM365(orgId); } catch (e) { m365LoadError = (e as Error).message; }
  try { googleConn = await loadOrgGoogle(orgId); } catch (e) { googleLoadError = (e as Error).message; }
  if (!domain) domain = m365Conn?.primary_domain ?? googleConn?.primary_domain ?? "";
  if (!domain && (wantM365 || wantGoogle)) {
    return json({ error: "primary_domain not set on integration and not provided in body" }, 400);
  }
  const workEmail = domain ? `${mailNick}@${domain}` : null;

  // Password: either the admin's manually-entered password or a strong auto-generated one.
  const tempPassword = (body.manual_password && body.manual_password.length >= 8)
    ? body.manual_password
    : generatePassword(16);
  const forceChange = body.force_change_password !== false;  // default true

  const result: Record<string, unknown> = { org_id: orgId, work_email: workEmail };
  let m365UserId: string | null = null;
  let googleUserId: string | null = null;

  // ---- M365 ----
  if (wantM365 && !m365Conn) {
    result.m365 = { ok: false, error: m365LoadError ?? "M365 not connected" };
  }
  if (wantM365 && m365Conn) {
    try {
      const created = await graphJson<{ id: string; userPrincipalName: string }>(orgId, {
        method: "POST",
        path: "/users",
        body: {
          accountEnabled: true,
          displayName: (body.display_name?.trim() || fullName),
          mailNickname: mailNick,
          userPrincipalName: workEmail,
          givenName: body.given_name ?? fullName.split(" ")[0],
          surname: body.surname ?? (fullName.split(" ").slice(1).join(" ") || null),
          jobTitle: body.designation ?? null,
          usageLocation: body.m365_usage_location ?? "IN",
          passwordProfile: {
            forceChangePasswordNextSignIn: forceChange,
            password: tempPassword,
          },
        },
      });
      m365UserId = created.id;
      result.m365 = { ok: true, user_id: m365UserId };

      // License assignment — best-effort, log error but don't fail provisioning.
      if (body.m365_license_skus?.length) {
        try {
          await graphJson(orgId, {
            method: "POST",
            path: `/users/${m365UserId}/assignLicense`,
            body: {
              addLicenses: body.m365_license_skus.map((skuId) => ({ skuId, disabledPlans: [] })),
              removeLicenses: [],
            },
          });
          (result.m365 as Record<string, unknown>).licenses = "assigned";
        } catch (e) {
          (result.m365 as Record<string, unknown>).license_error = (e as Error).message;
        }
      }
    } catch (e) {
      result.m365 = { ok: false, error: (e as Error).message };
    }
  }

  // ---- Google ----
  if (wantGoogle && !googleConn) {
    result.google = { ok: false, error: googleLoadError ?? "Google not connected" };
  }
  if (wantGoogle && googleConn) {
    try {
      const created = await googleJson<{ id: string }>(orgId, {
        method: "POST",
        path: "/users",
        body: {
          primaryEmail: workEmail,
          name: { givenName: body.given_name ?? fullName.split(" ")[0], familyName: body.surname ?? (fullName.split(" ").slice(1).join(" ") || fullName) },
          password: tempPassword,
          changePasswordAtNextLogin: forceChange,
          organizations: body.designation ? [{ title: body.designation, primary: true, type: "work" }] : undefined,
        },
      });
      googleUserId = created.id;
      result.google = { ok: true, user_id: googleUserId };
    } catch (e) {
      result.google = { ok: false, error: (e as Error).message };
    }
  }

  // ---- gate: if every requested provider failed, abort before creating a
  //          phantom employees row. The browser shows the error from result.m365
  //          / result.google and the admin can retry cleanly.
  const m365Failed   = wantM365   && (result.m365 as { ok?: boolean } | undefined)?.ok !== true;
  const googleFailed = wantGoogle && (result.google as { ok?: boolean } | undefined)?.ok !== true;
  const everyRequestedFailed = (wantM365 || wantGoogle) && m365Failed && googleFailed;
  if (everyRequestedFailed) {
    return json(result, 400);
  }

  // ---- employees row ----
  const { data: emp, error: empErr } = await admin
    .from("employees")
    .insert({
      org_id: orgId,
      full_name: fullName,
      personal_email: body.personal_email ?? null,
      work_email: workEmail,
      employee_code: body.employee_code ?? null,
      designation: body.designation ?? null,
      department_id: body.department_id ?? null,
      manager_id: body.manager_id ?? null,
      doj: body.doj ?? null,
      status: "active",
      source: "rudrans_created",
      m365_user_id: m365UserId,
      google_user_id: googleUserId,
      m365_license_skus: body.m365_license_skus ?? [],
      created_by: callerId,
    })
    .select("id")
    .single();
  if (empErr) {
    // The directory users were created — surface but don't roll back; admin can reconcile.
    return json({ ...result, employee_insert_error: empErr.message }, 207);
  }
  result.employee_id = emp.id;

  await admin.from("employee_audit").insert({
    org_id: orgId, employee_id: emp.id, actor_id: callerId,
    action: "created", target: workEmail,
    detail: { m365: m365UserId, google: googleUserId },
  });

  // ---- welcome mail ----
  if (body.personal_email) {
    let ccLine = "";
    if (body.manager_id) {
      const { data: mgr } = await admin.from("employees").select("work_email, full_name").eq("id", body.manager_id).maybeSingle();
      if (mgr?.work_email) ccLine = mgr.work_email;
    }
    const r = await sendGraphEmail({
      orgId,
      to: body.personal_email,
      cc: ccLine || undefined,
      subject: `Your work account is ready — ${workEmail}`,
      html: welcomeTemplate(fullName, workEmail ?? "", tempPassword),
    });
    result.welcome_mail = r;
  } else {
    result.welcome_mail = { skipped: "no_personal_email" };
  }

  // Echo the password back to the wizard so the admin can copy/show it on the
  // Finish screen (matches Microsoft's "Add a user" final step). Only included
  // when the caller explicitly asks — the request itself is over HTTPS, the
  // password is already in transit, and the welcome mail (when sent) carries
  // the same value.
  if (body.return_password) {
    result.password = tempPassword;
    result.force_change_password = forceChange;
  }

  return json(result, 200);
});

// ============== helpers ==============

function generatePassword(len: number): string {
  // Sufficient entropy for Azure AD's default complexity policy.
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%&*-_=+?";
  const all = upper + lower + digits + special;
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const out = [pick(upper), pick(lower), pick(digits), pick(special)];
  for (let i = out.length; i < len; i++) out.push(pick(all));
  // Fisher-Yates shuffle so the required chars aren't at the front.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

function welcomeTemplate(name: string, upn: string, password: string): string {
  return `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#1f2937">
  <h2 style="color:#0ea5e9;margin:0 0 16px">Welcome, ${escapeHtml(name)}</h2>
  <p>Your work account has been created. Use the credentials below to sign in to Microsoft 365 / Google Workspace.</p>
  <table style="border-collapse:collapse;margin:16px 0;background:#f9fafb;padding:12px;border-radius:8px;width:100%">
    <tr><td style="padding:6px 12px;color:#6b7280;width:160px">Sign-in email</td><td style="padding:6px 12px;font-family:Menlo,monospace"><strong>${escapeHtml(upn)}</strong></td></tr>
    <tr><td style="padding:6px 12px;color:#6b7280">Temporary password</td><td style="padding:6px 12px;font-family:Menlo,monospace"><strong>${escapeHtml(password)}</strong></td></tr>
  </table>
  <p style="font-size:13px;color:#dc2626"><strong>You will be asked to set a new password on first sign-in.</strong></p>
  <p style="font-size:12px;color:#6b7280">If you didn't expect this email, please contact your IT administrator.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
