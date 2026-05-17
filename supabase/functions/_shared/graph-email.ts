// Shared helper: send an email — picks Microsoft Graph or Gmail based on
// which provider the org has connected.
//
// Two modes:
//
//   • Per-org (preferred): pass `orgId`. We look up the org's M365 connection
//     (org_integrations.tenant_id) and mailbox (organizations.em_sender_email)
//     and send FROM that mailbox using application-permission Graph. The
//     recipient sees the email coming from the customer's own domain (e.g.
//     hr@customer.com), not from Rudrans. Requires the customer's admin to
//     grant Mail.Send when consenting.
//
//   • Global fallback: no orgId, or org has no M365 / em_sender_email. Falls
//     back to the Rudrans-owned mailbox we use for auth emails. Used for
//     system-level notifications (DLP alerts, billing, etc.).

import { adminClient } from "./crypto.ts";
import { getIntegrations } from "./integrations.ts";

export async function sendGraphEmail(opts: {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  html: string;
  /** When set, send from this org's M365 mailbox if configured. */
  orgId?: string;
}): Promise<{ ok: boolean; error?: string; sentFrom?: string }> {
  const cfg = await getIntegrations([
    "MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "AUTH_EMAIL_FROM",
    "DIRECTORY_M365_CLIENT_ID", "DIRECTORY_M365_CLIENT_SECRET",
  ]);

  // Try the per-org mailbox first — M365 takes priority if both are connected.
  if (opts.orgId) {
    const perOrg = await tryPerOrg(opts.orgId, cfg, opts);
    if (perOrg.attempted) return perOrg.result;
    const perOrgGmail = await tryPerOrgGmail(opts.orgId, opts);
    if (perOrgGmail.attempted) return perOrgGmail.result;
  }

  // Global fallback (Rudrans mailbox).
  const TENANT_ID = cfg.MICROSOFT_TENANT_ID;
  const CLIENT_ID = cfg.MICROSOFT_CLIENT_ID;
  const CLIENT_SECRET = cfg.MICROSOFT_CLIENT_SECRET;
  const FROM = cfg.AUTH_EMAIL_FROM || "itsupport@wellnessextract.com";
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    return { ok: false, error: "Microsoft Graph not configured (Admin → Integrations → Email)" };
  }
  return sendVia(TENANT_ID, CLIENT_ID, CLIENT_SECRET, FROM, opts);
}

async function tryPerOrg(
  orgId: string,
  cfg: Record<string, string>,
  opts: { to: string | string[]; cc?: string | string[]; subject: string; html: string },
): Promise<{ attempted: boolean; result: { ok: boolean; error?: string; sentFrom?: string } }> {
  const admin = adminClient();

  const [{ data: org }, { data: integ }] = await Promise.all([
    admin.from("organizations").select("em_sender_email, em_sender_display_name").eq("id", orgId).maybeSingle(),
    admin.from("org_integrations").select("tenant_id, status").eq("org_id", orgId).eq("provider", "m365").maybeSingle(),
  ]);

  const senderEmail = (org?.em_sender_email ?? "").trim();
  const tenantId = (integ?.tenant_id ?? "").trim();
  if (!senderEmail || !tenantId || integ?.status === "disconnected") {
    return { attempted: false, result: { ok: false } };
  }

  // For customer-tenant sends we re-use the multi-tenant directory app (the
  // same one customers consent to via /employees/integrations). Customer must
  // include Mail.Send in their admin consent.
  const CLIENT_ID = cfg.DIRECTORY_M365_CLIENT_ID;
  const CLIENT_SECRET = cfg.DIRECTORY_M365_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return {
      attempted: true,
      result: { ok: false, error: "DIRECTORY_M365_CLIENT_ID/SECRET missing — cannot send from customer mailbox" },
    };
  }

  return { attempted: true, result: await sendVia(tenantId, CLIENT_ID, CLIENT_SECRET, senderEmail, opts) };
}

// Per-org Gmail path: customer connected Google Workspace via OAuth. The
// connected admin's access token has the `gmail.send` scope, so we can send
// AS that admin's mailbox. If em_sender_email is set, we send as that mailbox
// (which works only if it == the connecting admin OR they've delegated). For
// arbitrary mailbox senders, the admin must have set up Gmail send-as
// delegation in their domain.
async function tryPerOrgGmail(
  orgId: string,
  opts: { to: string | string[]; cc?: string | string[]; subject: string; html: string },
): Promise<{ attempted: boolean; result: { ok: boolean; error?: string; sentFrom?: string } }> {
  const admin = adminClient();
  const [{ data: org }, { data: integ }] = await Promise.all([
    admin.from("organizations").select("em_sender_email, em_sender_display_name").eq("id", orgId).maybeSingle(),
    admin.from("org_integrations").select("status, impersonate_subject").eq("org_id", orgId).eq("provider", "google").maybeSingle(),
  ]);

  if (!integ || integ.status === "disconnected") {
    return { attempted: false, result: { ok: false } };
  }
  // Default sender = the admin who connected; allow override via em_sender_email.
  const senderEmail = ((org?.em_sender_email ?? "").trim()) || ((integ.impersonate_subject as string | null) ?? "").trim();
  if (!senderEmail) {
    return { attempted: false, result: { ok: false } };
  }

  // OAuth-based token (gmail.send scope is in the consent set).
  let token: string;
  try {
    const { googleTokenFor } = await import("./google.ts");
    token = await googleTokenFor(orgId);
  } catch (e) {
    return { attempted: true, result: { ok: false, error: `gmail token: ${(e as Error).message}` } };
  }

  // Build RFC 822.
  const toList = Array.isArray(opts.to) ? opts.to.filter(Boolean) : [opts.to].filter(Boolean);
  const ccList = Array.isArray(opts.cc) ? (opts.cc as string[]).filter(Boolean) : (opts.cc ? [opts.cc] : []);
  const displayName = (org?.em_sender_display_name ?? "").trim();
  const fromHeader = displayName ? `"${displayName}" <${senderEmail}>` : senderEmail;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${toList.join(", ")}`,
    ...(ccList.length ? [`Cc: ${ccList.join(", ")}`] : []),
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
  ];
  const raw = `${headers.join("\r\n")}\r\n\r\n${opts.html}`;
  const rawB64 = base64UrlEncode(new TextEncoder().encode(raw));

  const sendResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(senderEmail)}/messages/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: rawB64 }),
    },
  );
  if (!sendResp.ok) {
    return { attempted: true, result: { ok: false, error: `gmail send (${senderEmail}): ${await sendResp.text()}` } };
  }
  return { attempted: true, result: { ok: true, sentFrom: senderEmail } };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendVia(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  fromEmail: string,
  opts: { to: string | string[]; cc?: string | string[]; subject: string; html: string },
): Promise<{ ok: boolean; error?: string; sentFrom?: string }> {
  const tokenResp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
    }),
  });
  if (!tokenResp.ok) return { ok: false, error: `token: ${await tokenResp.text()}` };
  const { access_token } = await tokenResp.json();

  const sendResp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: opts.subject,
          body: { contentType: "HTML", content: opts.html },
          toRecipients: toRecipients(opts.to),
          ccRecipients: opts.cc ? toRecipients(opts.cc) : [],
        },
        saveToSentItems: false,
      }),
    },
  );
  if (!sendResp.ok) return { ok: false, error: `graph send (${fromEmail}): ${await sendResp.text()}` };
  return { ok: true, sentFrom: fromEmail };
}

function toRecipients(addrs: string | string[]): Array<{ emailAddress: { address: string } }> {
  const list = Array.isArray(addrs) ? addrs : [addrs];
  return list.filter(Boolean).map((a) => ({ emailAddress: { address: a } }));
}
