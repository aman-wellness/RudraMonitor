// Shared helper: send an email via Microsoft Graph using the same credentials
// the auth-email hook uses. Free for us — runs on the existing M365 mailbox.

import { getIntegrations } from "./integrations.ts";

export async function sendGraphEmail(opts: { to: string; subject: string; html: string }): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getIntegrations(["MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "AUTH_EMAIL_FROM"]);
  const TENANT_ID = cfg.MICROSOFT_TENANT_ID;
  const CLIENT_ID = cfg.MICROSOFT_CLIENT_ID;
  const CLIENT_SECRET = cfg.MICROSOFT_CLIENT_SECRET;
  const FROM = cfg.AUTH_EMAIL_FROM || "itsupport@wellnessextract.com";
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    return { ok: false, error: "Microsoft Graph not configured (Admin → Integrations → Email)" };
  }

  const tokenResp = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
    }),
  });
  if (!tokenResp.ok) return { ok: false, error: `token: ${await tokenResp.text()}` };
  const { access_token } = await tokenResp.json();

  const sendResp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: opts.subject,
          body: { contentType: "HTML", content: opts.html },
          toRecipients: [{ emailAddress: { address: opts.to } }],
        },
        saveToSentItems: false,
      }),
    },
  );
  if (!sendResp.ok) return { ok: false, error: `graph send: ${await sendResp.text()}` };
  return { ok: true };
}
