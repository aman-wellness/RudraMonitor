// Supabase Auth "Send Email Hook" target.
//
// Why this exists: the project's Microsoft 365 tenant disallows basic-auth SMTP
// (Microsoft policy default since 2023, error 5.7.139). Supabase only supports
// basic-auth SMTP, so direct SMTP delivery from supabase-auth → M365 fails.
// Instead, we register THIS function as the auth Send Email Hook and deliver
// every auth email (recovery, invite, magic-link, signup confirmation, email
// change, reauthentication) via Microsoft Graph API using app-only credentials
// — same mailbox (`no-reply@wellnessextract.com`), HTTPS instead of SMTP, no
// basic auth involved.
//
// Auth: Supabase signs each hook payload with the secret you set when
// configuring the hook in Supabase dashboard. We verify HMAC-SHA256(payload)
// against the `webhook-signature` header (standard-webhooks spec).
//
// Required env / secrets (already set on this project):
//   MICROSOFT_TENANT_ID          – Azure AD tenant ID (Directory ID)
//   MICROSOFT_CLIENT_ID          – Application (client) ID with Mail.Send (Application) permission
//   MICROSOFT_CLIENT_SECRET      – Client secret value
//   AUTH_EMAIL_FROM              – Sender mailbox (defaults to no-reply@wellnessextract.com)
//   SUPABASE_AUTH_HOOK_SECRET    – HMAC secret you paste into the dashboard hook config

import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";

// Hook secret stays in env (it's how Supabase signs requests; rotating it
// requires updating both Supabase Auth config and this function in lockstep).
const HOOK_SECRET = (Deno.env.get("SUPABASE_AUTH_HOOK_SECRET") ?? "").replace(/^v1,whsec_/, "");

type Action =
  | "signup" | "login" | "magiclink" | "recovery" | "invite"
  | "email_change" | "email_change_new" | "email_change_current"
  | "reauthentication" | "password_changed_notification";

interface AuthHookPayload {
  user: {
    id: string;
    email: string;
    user_metadata?: Record<string, unknown>;
  };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: Action;
    site_url: string;
    token_new?: string;
    token_hash_new?: string;
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // 1. Verify the standard-webhooks signature.
  const rawBody = await req.text();
  if (HOOK_SECRET) {
    const ok = await verifyWebhook(req.headers, rawBody, HOOK_SECRET);
    if (!ok) return json({ error: "invalid signature" }, 401);
  }

  let body: AuthHookPayload;
  try { body = JSON.parse(rawBody); } catch { return json({ error: "invalid json" }, 400); }

  const action = body.email_data?.email_action_type;
  const to = body.user?.email;
  if (!to || !action) return json({ error: "missing user.email or email_action_type" }, 400);

  // 2. Build the verification URL the email links to. Supabase normally
  //    constructs this itself when sending via its own SMTP; for hooks we
  //    have to rebuild it from token_hash + redirect_to.
  //    The verify endpoint lives on the Supabase project URL, NOT on
  //    body.email_data.site_url (which in hook payloads sometimes already
  //    contains `/auth/v1` and would double-prefix). Use SUPABASE_URL.
  const projectUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const appUrl = (Deno.env.get("APP_URL") ?? body.email_data.site_url ?? "http://localhost:3000").replace(/\/auth\/v1\/?$/, "").replace(/\/+$/, "");
  const tokenHash = body.email_data.token_hash;
  const redirect = body.email_data.redirect_to ?? `${appUrl}/post-login`;
  // For notification-only actions there is no token to verify — link goes to
  // the app's login page instead. For all token-based actions, point at the
  // Supabase Auth verify endpoint which exchanges the token for a session.
  const isNotification = action === "password_changed_notification";
  const ctaUrl = isNotification
    ? `${appUrl}/login`
    : `${projectUrl}/auth/v1/verify?token=${tokenHash}&type=${action}&redirect_to=${encodeURIComponent(redirect)}`;

  const inviteRole = (body.user?.user_metadata?.invite_role as string | undefined) ?? null;
  const fullName = (body.user?.user_metadata?.full_name as string | undefined) ?? null;
  const { subject, html } = template(action, ctaUrl, body.user?.email ?? "", inviteRole, fullName, appUrl);

  // 3. Pull live credentials (DB-first, env fallback) and get a fresh Graph
  //    API access token via client_credentials.
  const cfg = await getIntegrations([
    "MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "AUTH_EMAIL_FROM",
  ]);
  const TENANT_ID = cfg.MICROSOFT_TENANT_ID;
  const CLIENT_ID = cfg.MICROSOFT_CLIENT_ID;
  const CLIENT_SECRET = cfg.MICROSOFT_CLIENT_SECRET;
  const FROM = cfg.AUTH_EMAIL_FROM || "itsupport@wellnessextract.com";
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    return json({ error: "Microsoft Graph credentials missing — set them in Admin → Integrations" }, 500);
  }

  const tokenResp = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!tokenResp.ok) {
    const t = await tokenResp.text();
    return json({ error: `token: ${t}` }, 500);
  }
  const tokenJson = await tokenResp.json();
  const accessToken = tokenJson.access_token as string;

  // 4. Send via Graph (no save-to-Sent items — keeps the mailbox clean).
  const sendResp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: false,
      }),
    },
  );
  if (!sendResp.ok) {
    const t = await sendResp.text();
    return json({ error: `graph send: ${t}` }, 500);
  }

  return json({ ok: true });
});

// ── helpers ────────────────────────────────────────────────────────────────

async function verifyWebhook(headers: Headers, body: string, secret: string): Promise<boolean> {
  const id = headers.get("webhook-id") ?? "";
  const ts = headers.get("webhook-timestamp") ?? "";
  const sig = headers.get("webhook-signature") ?? "";
  if (!id || !ts || !sig) return false;

  const toSign = `${id}.${ts}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    base64Decode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(toSign));
  const expectedB64 = base64Encode(new Uint8Array(expected));

  // Header is space-separated list of "v1,<sig>" entries — match any.
  return sig.split(" ").some((part) => {
    const [, value] = part.split(",");
    return value === expectedB64;
  });
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function base64Encode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function template(
  action: Action,
  link: string,
  email: string,
  inviteRole: string | null,
  fullName: string | null,
  appUrl: string,
): { subject: string; html: string } {
  // Branded HTML email shell. Wrap accepts an optional list of "feature
  // bullets" so invite emails can introduce Rudrans, and an optional
  // "info note" callout (e.g. "you'll be billed via your partner").
  const wrap = (
    heading: string,
    intro: string,
    cta: string,
    opts: { bullets?: Array<{ icon: string; title: string; body: string }>; note?: string; signoff?: string } = {},
  ) => {
    const greeting = fullName ? `Hi ${fullName},` : "Hi there,";
    const bullets = (opts.bullets ?? []).map((b) => `
      <tr><td style="padding:10px 0;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="36" valign="top" style="font-size:18px;line-height:1;">${b.icon}</td>
          <td style="font-size:13px;line-height:1.55;color:#334155;">
            <strong style="color:#0f172a;">${b.title}</strong><br>
            <span style="color:#64748b;">${b.body}</span>
          </td>
        </tr></table>
      </td></tr>`).join("");

    const note = opts.note
      ? `<p style="margin:20px 0 0;padding:12px 14px;background:#eef2ff;border-left:3px solid #6366f1;border-radius:6px;font-size:12px;line-height:1.55;color:#3730a3;">${opts.note}</p>`
      : "";

    const featureBlock = bullets ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 8px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;padding:8px 0;">
        ${bullets}
      </table>` : "";

    const sign = opts.signoff ?? "— The Rudrans team";

    return /* html */`
<!DOCTYPE html>
<html><body style="margin:0;background:#f4f5f7;font-family:Inter,system-ui,Segoe UI,sans-serif;color:#1a1a1a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
        <tr><td style="padding:28px 32px 0;">
          <div style="display:inline-block;font-weight:700;font-size:18px;color:#0f172a;letter-spacing:-0.01em;">Rudrans</div>
          <span style="display:inline-block;margin-left:6px;font-size:10px;font-weight:600;color:#6366f1;background:#eef2ff;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:0.05em;vertical-align:2px;">Workforce monitoring</span>
        </td></tr>
        <tr><td style="padding:24px 32px 8px;">
          <h1 style="font-size:22px;line-height:1.3;margin:0 0 14px;color:#0f172a;">${heading}</h1>
          <p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 8px;">${greeting}</p>
          <p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 22px;">${intro}</p>
          <a href="${link}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 22px;border-radius:8px;font-weight:500;text-decoration:none;font-size:14px;">${cta}</a>
          ${featureBlock}
          ${note}
          <p style="font-size:12px;color:#94a3b8;margin:22px 0 0;line-height:1.5;">Or paste this link in your browser:<br><span style="word-break:break-all;color:#475569;">${link}</span></p>
          <p style="font-size:13px;color:#475569;margin:22px 0 0;">${sign}</p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;line-height:1.5;">
          You received this email at ${email}. If you weren't expecting it, you can safely ignore — no action will be taken.
          Need help? Reply to this email or write to <a href="mailto:itsupport@wellnessextract.com" style="color:#6366f1;text-decoration:none;">itsupport@wellnessextract.com</a>.
        </td></tr>
      </table>
      <p style="font-size:11px;color:#94a3b8;margin-top:16px;">© Rudrans by Wellness Extract — wellnessextract.com</p>
    </td></tr>
  </table>
</body></html>`;
  };

  // Feature bullets reused across invite variants.
  const customerFeatures = [
    { icon: "🖥️", title: "Real-time activity & screenshots", body: "See what's happening across every team device — apps, websites, idle time, periodic screenshots." },
    { icon: "📊", title: "Productivity insights",            body: "Daily / weekly reports, productive vs. distracting time, per-employee scoring." },
    { icon: "🛡️", title: "DLP & compliance",                 body: "Catch unauthorized USB drives, file uploads, suspicious browsing — all from one dashboard." },
    { icon: "👥", title: "Manage your whole team",            body: "Add departments, set policies, invite admins, all from your portal." },
  ];

  const partnerFeatures = [
    { icon: "💼", title: "Onboard customers in minutes",     body: "Register orgs, issue licenses, send invites — all from your partner portal." },
    { icon: "💰", title: "Wholesale pricing & commissions",  body: "Buy at partner rates, sell at list price, earn 20% renewal commission." },
    { icon: "📈", title: "Track every account",               body: "Live status of customer licenses, agent counts, billing, and renewal dates." },
    { icon: "🤝", title: "Direct support",                    body: "Slack/email priority support and co-marketing assets when you need them." },
  ];

  switch (action) {
    case "invite": {
      if (inviteRole === "partner") {
        return {
          subject: "Welcome to Rudrans — your partner access is ready",
          html: wrap(
            "You're now a Rudrans partner",
            "Your partner account has been activated. Click below to set your password and access the partner portal where you can onboard customers, issue licenses, and track commissions.",
            "Activate Partner Account",
            {
              bullets: partnerFeatures,
              note: "This invite link expires in 24 hours. If it expires, ask your Rudrans admin to resend it from the Partners page.",
            },
          ),
        };
      }
      return {
        subject: "Welcome to Rudrans — your account is ready",
        html: wrap(
          "Welcome to Rudrans",
          "Your Rudrans workspace has been created and is waiting for you. Click below to set your password and start monitoring your team's productivity, security, and time.",
          "Accept Invite & Set Password",
          {
            bullets: customerFeatures,
            note: "After signing in, head to the <strong>Setup</strong> section to download the agent and roll it out to your team. Each employee gets a license key during installation.",
          },
        ),
      };
    }

    case "recovery":
      return {
        subject: "Reset your Rudrans password",
        html: wrap(
          "Reset your password",
          "We received a request to reset the password for your Rudrans account. Click the button below to choose a new one. This link expires in 60 minutes.",
          "Reset Password",
          {
            note: "If you didn't request a password reset, you can safely ignore this email — your current password remains unchanged. If you keep getting these unexpectedly, please reach out to your administrator.",
          },
        ),
      };

    case "magiclink":
      return {
        subject: "Your Rudrans sign-in link",
        html: wrap(
          "Sign in to Rudrans",
          "Use the button below to sign in to your Rudrans account. This link is single-use and expires in 60 minutes.",
          "Sign In",
        ),
      };

    case "signup":
      return {
        subject: "Confirm your Rudrans account",
        html: wrap(
          "Confirm your email",
          "Thanks for signing up for Rudrans! Please verify your email address to activate your account.",
          "Confirm Email",
        ),
      };

    case "email_change":
    case "email_change_new":
    case "email_change_current":
      return {
        subject: "Confirm your new email — Rudrans",
        html: wrap(
          "Confirm email change",
          "A request was made to change the email address on your Rudrans account. Click below to confirm this is correct.",
          "Confirm Change",
          {
            note: "If you didn't request this change, please contact <a href=\"mailto:itsupport@wellnessextract.com\" style=\"color:#3730a3;\">itsupport@wellnessextract.com</a> immediately — your account may have been compromised.",
          },
        ),
      };

    case "reauthentication":
      return {
        subject: "Confirm your identity — Rudrans",
        html: wrap(
          "Just confirming it's you",
          "We need to verify your identity before completing this sensitive action. Click below to continue.",
          "Continue",
        ),
      };

    case "password_changed_notification":
      return {
        subject: "Your Rudrans password was changed",
        html: wrap(
          "Password changed successfully",
          "This is a confirmation that the password for your Rudrans account was just updated. You can now sign in with your new password.",
          "Sign In",
          {
            note: "<strong>Didn't change your password?</strong> Reset it again immediately and contact <a href=\"mailto:itsupport@wellnessextract.com\" style=\"color:#3730a3;\">itsupport@wellnessextract.com</a> — someone else may have access to your account.",
          },
        ),
      };

    default:
      return {
        subject: "Rudrans",
        html: wrap("Action required", "Click below to continue with your account.", "Open Rudrans"),
      };
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
