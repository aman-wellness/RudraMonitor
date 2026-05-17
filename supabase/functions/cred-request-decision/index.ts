// GET /functions/v1/cred-request-decision?do=mgr_approve|mgr_reject|it_approve|it_reject&t=<token>
//
// Magic-link consumer for credential-request approvals. Stateless from the
// caller's POV — each link maps to one of four row-level random tokens stored
// on credential_requests when the row was created. On a hit:
//   mgr_approve → status pending_it, mail IT (TO) + manager (CC) with their links
//   mgr_reject  → status rejected, mail requester
//   it_approve  → status fulfilled, decrypt each credential, send per-platform
//                 emails to requester, insert credential_assignments
//   it_reject   → status rejected, mail requester
//
// Replies with a tiny HTML page so the recipient sees confirmation in-browser
// after clicking from the email client.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sendGraphEmail } from "../_shared/graph-email.ts";
import { getIntegration } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Frontend origin to redirect to for the user-visible result page. Resolved
// lazily per request (so admin can change APP_PUBLIC_URL in Integrations
// without a redeploy), but we cache after first lookup.
let APP_PUBLIC_URL_FALLBACK = "http://localhost:3000";

type Decision = "mgr_approve" | "mgr_reject" | "it_approve" | "it_reject";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Resolve the frontend origin from the integrations table before any html()
  // call so the redirect URL is correct. Falls back to localhost in dev.
  try {
    const cfg = await getIntegration("APP_PUBLIC_URL");
    if (cfg) APP_PUBLIC_URL_FALLBACK = cfg.replace(/\/+$/, "");
  } catch { /* keep fallback */ }

  if (req.method !== "GET") return html(405, "Method not allowed");

  const url = new URL(req.url);
  const decision = url.searchParams.get("do") as Decision | null;
  const token = url.searchParams.get("t") ?? "";
  if (!decision || !token) return html(400, "Missing parameters.");
  if (!["mgr_approve", "mgr_reject", "it_approve", "it_reject"].includes(decision)) {
    return html(400, "Invalid action.");
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const col = ({
    mgr_approve: "manager_approve_token",
    mgr_reject:  "manager_reject_token",
    it_approve:  "it_approve_token",
    it_reject:   "it_reject_token",
  } as const)[decision];

  // Look up the request via the matching token column.
  const { data: reqRow } = await admin
    .from("credential_requests")
    .select("*")
    .eq(col, token)
    .maybeSingle();
  if (!reqRow) return html(404, "This link has already been used or is invalid.");

  // Sanity gates so out-of-order clicks don't corrupt state.
  if (decision.startsWith("mgr") && reqRow.status !== "pending_manager") {
    return html(409, `This request is no longer pending manager approval (currently: ${reqRow.status}).`);
  }
  if (decision.startsWith("it") && !["pending_manager", "pending_it"].includes(reqRow.status)) {
    return html(409, `This request is no longer pending IT decision (currently: ${reqRow.status}).`);
  }

  const fnsBase = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/cred-request-decision`;

  // Helper: clear the consumed tokens so links can't be replayed.
  const consume = async (extra: Record<string, unknown>) => {
    await admin.from("credential_requests")
      .update({ ...extra, [col]: null })
      .eq("id", reqRow.id);
  };

  // Look up requester + org for the result mail.
  const { data: emp } = await admin
    .from("employees")
    .select("id, full_name, work_email, personal_email, org_id")
    .eq("id", reqRow.requester_employee_id)
    .single();
  if (!emp) return html(500, "Requester not found.");
  const { data: org } = await admin.from("organizations").select("name").eq("id", emp.org_id).single();

  // -------- MANAGER REJECT --------
  if (decision === "mgr_reject") {
    await consume({ status: "rejected", manager_decided_at: new Date().toISOString() });
    await admin.from("credential_request_events").insert({
      request_id: reqRow.id, org_id: emp.org_id, actor: "manager", event: "manager_rejected",
    });
    await sendGraphEmail({ orgId: emp.org_id,
      to: emp.work_email ?? emp.personal_email ?? "",
      subject: "Your software access request was declined",
      html: `<p>Hi ${escape(emp.full_name)},</p><p>Your manager declined your software access request. Please follow up with them for details.</p>`,
    });
    return html(200, "Request rejected and the requester has been notified.");
  }

  // -------- MANAGER APPROVE -> route to IT --------
  if (decision === "mgr_approve") {
    await consume({ status: "pending_it", manager_decided_at: new Date().toISOString() });
    await admin.from("credential_request_events").insert({
      request_id: reqRow.id, org_id: emp.org_id, actor: "manager", event: "manager_approved",
    });

    // IT recipients: prefer what was captured at submit time (immutable
    // snapshot). If that's empty — usually because the admin hadn't set them
    // yet when the employee submitted — fall back to the live org settings.
    let itRecipients = (reqRow.it_recipients ?? []) as string[];
    if (!itRecipients.length) {
      const { data: orgNow } = await admin
        .from("organizations").select("it_recipient_emails").eq("id", emp.org_id).single();
      itRecipients = (orgNow?.it_recipient_emails ?? []) as string[];
      if (itRecipients.length) {
        // Persist the resolved list onto the request so subsequent steps and
        // audit views see who was actually notified.
        await admin.from("credential_requests").update({ it_recipients: itRecipients }).eq("id", reqRow.id);
      }
    }
    if (!itRecipients.length) {
      return html(200, "Approved, but no IT recipients are configured. Ask your administrator to set IT emails under Credentials → Requests, then re-trigger this request.");
    }
    const approveUrl = `${fnsBase}?do=it_approve&t=${encodeURIComponent(reqRow.it_approve_token)}`;
    const rejectUrl = `${fnsBase}?do=it_reject&t=${encodeURIComponent(reqRow.it_reject_token)}`;

    // Build the IT-stage email (TO IT, CC manager).
    let mgrEmail: string | null = null;
    if (reqRow.manager_id) {
      const { data: m } = await admin.from("employees").select("work_email").eq("id", reqRow.manager_id).single();
      mgrEmail = m?.work_email ?? null;
    }
    const credNames = ((reqRow.requested_credential_ids ?? []) as string[]).length
      ? (await admin.from("credentials_safe").select("platform_name").in("id", reqRow.requested_credential_ids as string[])).data?.map((c: { platform_name: string }) => c.platform_name) ?? []
      : [];
    await sendGraphEmail({ orgId: emp.org_id,
      to: itRecipients[0],
      cc: [...itRecipients.slice(1), ...(mgrEmail ? [mgrEmail] : [])],
      subject: `[IT action] Approved by manager — provision creds for ${emp.full_name}`,
      html: itMailTemplate(emp.full_name, emp.work_email ?? "", credNames, reqRow.custom_text, approveUrl, rejectUrl, org?.name ?? ""),
    });
    return html(200, "Approved. The IT team has been notified.");
  }

  // -------- IT REJECT --------
  if (decision === "it_reject") {
    await consume({ status: "rejected", it_decided_at: new Date().toISOString() });
    await admin.from("credential_request_events").insert({
      request_id: reqRow.id, org_id: emp.org_id, actor: "it", event: "it_rejected",
    });
    await sendGraphEmail({ orgId: emp.org_id,
      to: emp.work_email ?? emp.personal_email ?? "",
      subject: "Your software access request was not fulfilled",
      html: `<p>Hi ${escape(emp.full_name)},</p><p>The IT team was unable to fulfil your request. Please follow up with them for details.</p>`,
    });
    return html(200, "Request rejected and the requester has been notified.");
  }

  // -------- IT APPROVE --> fulfil --------
  // For each credential id, decrypt and send a SEPARATE per-platform email,
  // and write a credential_assignments row.
  const credIds = (reqRow.requested_credential_ids ?? []) as string[];
  const key = await getIntegration("CRED_VAULT_ENC_KEY");
  if (!key) return html(500, "CRED_VAULT_ENC_KEY missing — admin must configure.");
  const deliveryEmail = emp.work_email ?? emp.personal_email;
  if (!deliveryEmail) return html(500, "Requester has no work_email/personal_email.");

  const outcomes: Array<{ cred_id: string; ok: boolean; error?: string }> = [];
  for (const cid of credIds) {
    try {
      const { data: cred } = await admin
        .from("credentials")
        .select("id, platform_name, login_url, username, notes, active, org_id")
        .eq("id", cid)
        .maybeSingle();
      if (!cred || cred.org_id !== emp.org_id) throw new Error("not found in org");
      if (!cred.active) throw new Error("inactive");

      const { data: pwd, error: rErr } = await admin.rpc("cred_reveal", { p_cred_id: cid, p_key: key });
      if (rErr) throw new Error(rErr.message);

      const mail = await sendGraphEmail({ orgId: emp.org_id,
        to: deliveryEmail,
        subject: `Account access: ${cred.platform_name}`,
        html: credEmail(emp.full_name, cred.platform_name, cred.login_url, cred.username, pwd as string, cred.notes),
      });
      if (!mail.ok) throw new Error(`mail: ${mail.error}`);

      await admin.from("credential_assignments").insert({
        org_id: emp.org_id, credential_id: cid, employee_id: emp.id,
        request_id: reqRow.id, sent_by: null, delivery_email: deliveryEmail,
      });
      outcomes.push({ cred_id: cid, ok: true });
    } catch (e) {
      outcomes.push({ cred_id: cid, ok: false, error: (e as Error).message });
    }
  }

  await consume({ status: "fulfilled", it_decided_at: new Date().toISOString(), fulfilled_at: new Date().toISOString() });
  await admin.from("credential_request_events").insert({
    request_id: reqRow.id, org_id: emp.org_id, actor: "it", event: "fulfilled", detail: { outcomes },
  });

  const failed = outcomes.filter((o) => !o.ok);
  return html(200, failed.length
    ? `Approved. ${outcomes.length - failed.length} of ${outcomes.length} credentials delivered. ${failed.length} failed — please retry from the admin portal.`
    : `Approved. All ${outcomes.length} credential(s) delivered to ${deliveryEmail}.`);
});

// ============== templates ==============

function itMailTemplate(name: string, email: string, credNames: string[], customText: string | null, approveUrl: string, rejectUrl: string, orgName: string): string {
  const items = credNames.length
    ? `<ul style="margin:8px 0 16px;padding-left:20px">${credNames.map((c) => `<li>${escape(c)}</li>`).join("")}</ul>`
    : "";
  const custom = customText
    ? `<p style="background:#f9fafb;padding:10px;border-radius:6px;font-size:13px;color:#475569"><strong>Other:</strong> ${escape(customText)}</p>`
    : "";
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#1f2937">
    <h2 style="color:#0ea5e9;margin:0 0 12px">Provision creds to ${escape(name)}</h2>
    <p>The manager has approved. Please review and dispatch.</p>
    <p><strong>Requester:</strong> ${escape(name)} &lt;${escape(email)}&gt;</p>
    ${items}
    ${custom}
    <p style="margin:24px 0">
      <a href="${escape(approveUrl)}" style="background:#10b981;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;margin-right:8px">Approve & send creds</a>
      <a href="${escape(rejectUrl)}" style="background:#ef4444;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600">Reject</a>
    </p>
    <p style="font-size:11px;color:#9ca3af">Sent from ${escape(orgName)} via Rudrans. Clicking Approve will decrypt and email each platform's credentials to the requester in separate messages.</p>
  </body></html>`;
}
function credEmail(name: string, platform: string, url: string | null, username: string | null, password: string, notes: string | null): string {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:24px;color:#1f2937">
    <h2 style="color:#0ea5e9;margin:0 0 8px">${escape(platform)} access</h2>
    <p>Hi ${escape(name)},</p>
    <p>Your request was approved. Use the credentials below to sign in to <strong>${escape(platform)}</strong>:</p>
    <table style="border-collapse:collapse;margin:16px 0;background:#f9fafb;padding:12px;border-radius:8px;width:100%">
      ${url ? `<tr><td style="padding:6px 12px;color:#6b7280;width:140px">Sign-in URL</td><td style="padding:6px 12px"><a href="${escape(url)}">${escape(url)}</a></td></tr>` : ""}
      ${username ? `<tr><td style="padding:6px 12px;color:#6b7280">Username</td><td style="padding:6px 12px;font-family:Menlo,monospace"><strong>${escape(username)}</strong></td></tr>` : ""}
      <tr><td style="padding:6px 12px;color:#6b7280">Password</td><td style="padding:6px 12px;font-family:Menlo,monospace"><strong>${escape(password)}</strong></td></tr>
    </table>
    ${notes ? `<p style="font-size:13px;color:#475569"><strong>Notes:</strong> ${escape(notes)}</p>` : ""}
    <p style="font-size:12px;color:#dc2626">Do not forward this email. If you didn't expect it, notify IT immediately.</p>
  </body></html>`;
}

// Redirect to the frontend `/r/decision` page. We pass status + a human
// message via query string so the React page can render a nice UI. This
// avoids fighting Supabase's edge-runtime Content-Type handling for inline
// HTML and gives us a polished result page using the app's design system.
function html(status: number, body: string): Response {
  const params = new URLSearchParams({
    status: status === 200 ? "ok" : status === 404 ? "expired" : status === 409 ? "stale" : "error",
    msg: body,
  });
  const url = `${APP_PUBLIC_URL_FALLBACK}/r/decision?${params.toString()}`;
  return new Response(null, {
    status: 303,
    headers: { Location: url, ...corsHeaders },
  });
}
function escape(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}
