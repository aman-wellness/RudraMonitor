// POST /functions/v1/cred-request-submit          (PUBLIC, gated by email domain)
// Body: { work_email, action: 'context' }   → { employee?, credentials, org_name }
//       { work_email, action: 'submit', credential_ids, custom_text? }
//                                            → creates credential_requests row + mails manager (CC IT)
//
// Authorisation model: the requester's email domain must match the
// `primary_domain` of a connected directory integration on this org. That's
// strong enough for a self-service form — every request still routes through
// manager + IT approval downstream, so unauthorized submissions can't extract
// credentials without explicit human approval at both stages.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sendGraphEmail } from "../_shared/graph-email.ts";
import { getIntegration } from "../_shared/integrations.ts";
import { randomToken } from "../_shared/crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { work_email?: string; action?: string; credential_ids?: string[]; custom_text?: string; manager_emails?: string[] };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const workEmail = (body.work_email ?? "").trim().toLowerCase();
  if (!workEmail || !workEmail.includes("@")) return json({ error: "work_email required" }, 400);
  const domain = workEmail.split("@")[1] ?? "";

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- domain → org resolution -----------------------------------------
  // First look up by exact work_email match (we already know which org they
  // belong to). Fall back to matching domain against any active integration's
  // primary_domain. If no match — reject silently with the same shape so an
  // outsider can't probe which domains are connected.
  let orgId: string | null = null;
  let employeeRow: { id: string; full_name: string; work_email: string | null; manager_id: string | null; department_id: string | null; status: string } | null = null;

  const { data: empByEmail } = await admin
    .from("employees")
    .select("id, org_id, full_name, work_email, manager_id, department_id, status")
    .ilike("work_email", workEmail)
    .maybeSingle();
  if (empByEmail) {
    orgId = empByEmail.org_id;
    employeeRow = empByEmail;
  } else {
    const { data: integ } = await admin
      .from("org_integrations")
      .select("org_id")
      .ilike("primary_domain", domain)
      .limit(1)
      .maybeSingle();
    if (integ) orgId = integ.org_id;
  }
  if (!orgId) {
    return json({ error: "This email isn't recognised. Use your work email — the same one your IT team has on file." }, 403);
  }
  if (employeeRow && employeeRow.status !== "active") {
    return json({ error: "Your account is not active. Contact IT." }, 403);
  }

  // ---- context fetch ----
  if (body.action === "context") {
    const { data: org } = await admin.from("organizations").select("name").eq("id", orgId).single();
    const deptScope = employeeRow?.department_id ?? "00000000-0000-0000-0000-000000000000";

    // Resolve default manager email from employees.manager_id so the form can
    // pre-check the user's assigned manager (they can still add/swap others).
    let defaultManagerEmail: string | null = null;
    if (employeeRow?.manager_id) {
      const { data: mgr } = await admin
        .from("employees").select("work_email").eq("id", employeeRow.manager_id).maybeSingle();
      defaultManagerEmail = (mgr?.work_email as string | null) ?? null;
    }

    // Candidate managers = only actual managers: employees rows that are
    // pointed at by someone else's `manager_id`. This matches the Managers
    // page (an "Assign reports" action is the only way to become eligible
    // here). Self-row filtered out.
    const { data: managerIdRows } = await admin
      .from("employees")
      .select("manager_id")
      .eq("org_id", orgId)
      .not("manager_id", "is", null);
    const managerIds = [...new Set((managerIdRows ?? []).map((r: { manager_id: string }) => r.manager_id))];

    let managerCandidates: Array<{ row_id: string; display_name: string; work_email: string }> = [];
    if (managerIds.length) {
      const { data: managers } = await admin
        .from("employees")
        .select("id, full_name, work_email, status")
        .in("id", managerIds)
        .neq("status", "offboarded");
      managerCandidates = (managers ?? [])
        .filter((m: { work_email: string | null }) => m.work_email && m.work_email.toLowerCase() !== workEmail)
        .map((m: { id: string; full_name: string; work_email: string }) => ({
          row_id: `emp:${m.id}`,
          display_name: m.full_name,
          work_email: m.work_email,
        }))
        .sort((a: { display_name: string }, b: { display_name: string }) => a.display_name.localeCompare(b.display_name));
    }

    const { data: creds } = await admin
      .from("credentials_safe")
      .select("id, platform_name, category, login_url, notes, owner_dept_id, tags")
      .eq("org_id", orgId)
      .eq("active", true)
      .or(`owner_dept_id.is.null,owner_dept_id.eq.${deptScope}`)
      .order("platform_name");

    return json({
      org_name: org?.name ?? "",
      employee: employeeRow ? { id: employeeRow.id, full_name: employeeRow.full_name, work_email: employeeRow.work_email } : null,
      manager_candidates: managerCandidates,
      default_manager_email: defaultManagerEmail,
      credentials: creds ?? [],
    }, 200);
  }

  // ---- submit ----
  if (body.action !== "submit") return json({ error: "unknown action" }, 400);
  const credentialIds = (body.credential_ids ?? []).filter(Boolean);
  const customText = (body.custom_text ?? "").trim();
  if (!credentialIds.length && !customText) {
    return json({ error: "Pick at least one credential or describe what you need" }, 400);
  }
  // Manager emails picked on the form — de-dupe + only keep ones that look
  // valid + aren't the requester themselves (prevents self-approval). Empty
  // is fine; we'll fall back to the auto-resolved manager / IT routing.
  const managerEmailsPicked = [...new Set(
    (body.manager_emails ?? [])
      .map((e) => String(e).trim().toLowerCase())
      .filter((e) => e.includes("@") && e !== workEmail),
  )];

  // Resolve manager and IT recipients. Picks from the form take precedence;
  // otherwise we fall back to employees.manager_id (auto-resolved).
  const requesterName = employeeRow?.full_name ?? workEmail;
  const requesterEmployeeId = employeeRow?.id ?? null;
  const managerId = employeeRow?.manager_id ?? null;

  const [{ data: org }, { data: mgr }] = await Promise.all([
    admin.from("organizations").select("it_recipient_emails, name").eq("id", orgId).single(),
    managerId
      ? admin.from("employees").select("id, full_name, work_email").eq("id", managerId).maybeSingle()
      : Promise.resolve({ data: null } as { data: null }),
  ]);
  const autoManagerEmail = mgr?.work_email ?? null;
  const itRecipients = (org?.it_recipient_emails ?? []) as string[];

  // Final manager TO list. Picks (multi) win; else auto manager (single).
  const managerTo = managerEmailsPicked.length > 0
    ? managerEmailsPicked
    : (autoManagerEmail ? [autoManagerEmail] : []);

  if (managerTo.length === 0 && itRecipients.length === 0) {
    return json({ error: "Pick at least one manager, or ask your administrator to configure IT recipients." }, 422);
  }

  // Random opaque tokens — single-use, cleared on consume by cred-request-decision.
  const mgrApprove = randomToken();
  const mgrReject = randomToken();
  const itApprove = randomToken();
  const itReject = randomToken();

  const { data: reqRow, error: insErr } = await admin
    .from("credential_requests")
    .insert({
      org_id: orgId,
      requester_employee_id: requesterEmployeeId,
      requester_email: workEmail,
      manager_id: managerId,
      requested_credential_ids: credentialIds,
      custom_text: customText || null,
      status: managerTo.length > 0 ? "pending_manager" : "pending_it",
      manager_approve_token: mgrApprove,
      manager_reject_token: mgrReject,
      it_approve_token: itApprove,
      it_reject_token: itReject,
      it_recipients: itRecipients,
      manager_emails_picked: managerTo,
    })
    .select("id, created_at")
    .single();
  if (insErr) return json({ error: `insert: ${insErr.message}` }, 500);

  await admin.from("credential_request_events").insert({
    request_id: reqRow.id, org_id: orgId,
    actor: "requester", actor_email: workEmail,
    event: "submitted",
    detail: { credential_ids: credentialIds, custom_text: customText },
  });

  // Build the manager-stage email (TO manager, CC IT).
  const appUrl = ((await getIntegration("APP_PUBLIC_URL")) || "").replace(/\/+$/, "");
  const fnsBase = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/cred-request-decision`;
  const approveUrl = `${fnsBase}?do=mgr_approve&t=${encodeURIComponent(mgrApprove)}`;
  const rejectUrl = `${fnsBase}?do=mgr_reject&t=${encodeURIComponent(mgrReject)}`;

  // Look up requested cred names for the email body.
  const credNames = credentialIds.length
    ? (await admin.from("credentials_safe").select("platform_name").in("id", credentialIds)).data?.map((c: { platform_name: string }) => c.platform_name) ?? []
    : [];

  if (managerTo.length > 0) {
    // Send to every picked manager (first as TO, rest as additional TOs).
    // The single-use manager_approve_token means whichever manager clicks
    // first wins — others' clicks will be rejected as "already used".
    await sendGraphEmail({ orgId: emp.org_id,
      to: managerTo,
      cc: itRecipients,
      subject: `[Approval needed] ${requesterName} requested software access`,
      html: managerMailTemplate(requesterName, workEmail, credNames, customText, approveUrl, rejectUrl, org?.name ?? ""),
    });
  } else {
    // No manager picked or on file — route directly to IT.
    await sendGraphEmail({ orgId: emp.org_id,
      to: itRecipients[0],
      cc: itRecipients.slice(1),
      subject: `[Approval needed — no manager] ${requesterName} requested software access`,
      html: managerMailTemplate(requesterName, workEmail, credNames, customText,
        `${fnsBase}?do=it_approve&t=${encodeURIComponent(itApprove)}`,
        `${fnsBase}?do=it_reject&t=${encodeURIComponent(itReject)}`, org?.name ?? ""),
    });
  }

  // Confirmation to the requester so they know it went through.
  await sendGraphEmail({ orgId: emp.org_id,
    to: workEmail,
    subject: "Your software access request was received",
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:20px;color:#1f2937">
      <p>Hi ${escape(requesterName)},</p>
      <p>We've received your request and routed it to ${
        managerTo.length > 0
          ? (managerTo.length === 1 ? "your manager" : `your ${managerTo.length} managers`) + " for approval"
          : "the IT team"
      }. You'll get the credentials in separate emails as each is approved.</p>
      <p style="font-size:12px;color:#6b7280">Reference: ${reqRow.id}</p>
    </body></html>`,
  });

  return json({ ok: true, request_id: reqRow.id, app_url: appUrl }, 200);
});

function managerMailTemplate(name: string, email: string, credNames: string[], customText: string, approveUrl: string, rejectUrl: string, orgName: string): string {
  const items = credNames.length
    ? `<ul style="margin:8px 0 16px;padding-left:20px">${credNames.map((c) => `<li>${escape(c)}</li>`).join("")}</ul>`
    : "";
  const custom = customText
    ? `<p style="background:#f9fafb;padding:10px;border-radius:6px;font-size:13px;color:#475569"><strong>Other:</strong> ${escape(customText)}</p>`
    : "";
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#1f2937">
    <h2 style="color:#0ea5e9;margin:0 0 12px">Software access request</h2>
    <p><strong>${escape(name)}</strong> (${escape(email)}) requested access to:</p>
    ${items}
    ${custom}
    <p style="margin:24px 0">
      <a href="${escape(approveUrl)}" style="background:#10b981;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;margin-right:8px">Approve</a>
      <a href="${escape(rejectUrl)}" style="background:#ef4444;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600">Reject</a>
    </p>
    <p style="font-size:11px;color:#9ca3af">Sent from ${escape(orgName)} via Rudrans. Each link is single-use.</p>
  </body></html>`;
}
function escape(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
