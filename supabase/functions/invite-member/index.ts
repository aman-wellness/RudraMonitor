// POST /functions/v1/invite-member
// Headers: Authorization: Bearer <user JWT>
// Body: { email, role: 'admin' | 'viewer', full_name? }
//
// Behaviour:
//   1. Verify the caller's JWT, look up which org they own.
//   2. Insert a pending org_members row (email, role, full_name, user_id=null).
//   3. Send a Supabase magic-link invite to the email.
// When the invitee confirms their email, a trigger fills in user_id automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { sendGraphEmail } from "../_shared/graph-email.ts";
import { findAuthUserIdByEmail } from "../_shared/find-user.ts";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ROLES = new Set(["admin", "viewer"]);

type Body = {
  email?: string;
  role?: string;
  full_name?: string;
  app_access?: string[] | null;
  app_access_levels?: Record<string, string> | null;
  // When true, skip the org_members upsert + role checks and just re-send
  // the invite email. Used by the "Resend invite" button in the admin
  // portal for pending users.
  resend?: boolean;
};

const APP_URL = Deno.env.get("APP_URL") ?? "https://ems.wellnessextract.com";

const ALLOWED_LEVELS = new Set(["view", "edit", "full"]);

// Mirror of src/lib/useAppAccess.ts APP_ACCESS_CODES — keep in sync. Any
// unknown code from the dashboard is silently dropped server-side.
const ALLOWED_ACCESS_CODES = new Set([
  "dashboard", "agents", "monitoring", "alerts", "dlp", "system_health",
  "performance", "reports", "setup", "employees", "groups", "managers",
  "credentials", "hardware", "offboarding", "integrations", "admin_portal",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  // Resolve caller via the anon-keyed client so the JWT is verified server-side.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "invalid token" }, 401);
  const callerId = userData.user.id;

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const email = (body.email ?? "").trim().toLowerCase();
  const role = (body.role ?? "").trim();
  const fullName = (body.full_name ?? "").trim() || null;
  const isResend = body.resend === true;
  if (!email || !email.includes("@")) return json({ error: "valid email required" }, 400);
  if (!isResend && !ALLOWED_ROLES.has(role)) return json({ error: "role must be admin or viewer" }, 400);

  // app_access: undefined / null → leave NULL (inherit org default).
  // Array → sanitize against the whitelist, store as text[].
  let appAccess: string[] | null = null;
  if (Array.isArray(body.app_access)) {
    appAccess = body.app_access.filter((c) => typeof c === "string" && ALLOWED_ACCESS_CODES.has(c));
  }
  // app_access_levels: sanitize against both the access whitelist and
  // the level enum. Drop keys not in appAccess (the picker keeps them
  // in sync; defensive on the server side).
  let appLevels: Record<string, string> | null = null;
  if (body.app_access_levels && typeof body.app_access_levels === "object") {
    const allowedSet = new Set(appAccess ?? []);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.app_access_levels)) {
      if (
        ALLOWED_ACCESS_CODES.has(k) &&
        allowedSet.has(k) &&
        typeof v === "string" &&
        ALLOWED_LEVELS.has(v)
      ) out[k] = v;
    }
    appLevels = out;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Find the caller's org (where they are owner). We restrict invites to the owner for now;
  // promote to "owner or admin" once the role-based permission story matures.
  const { data: orgs, error: orgErr } = await admin
    .from("organizations")
    .select("id")
    .eq("owner_user_id", callerId)
    .limit(1);
  if (orgErr) return json({ error: orgErr.message }, 500);
  if (!orgs || orgs.length === 0) return json({ error: "only the org owner can invite" }, 403);
  const orgId = orgs[0].id as string;

  // Resend path: the pending row already exists. Skip the upsert. Verify
  // there IS a pending row for this email in this org before re-sending.
  if (isResend) {
    const { data: existing } = await admin
      .from("org_members")
      .select("id, user_id")
      .eq("org_id", orgId)
      .ilike("email", email)
      .maybeSingle();
    if (!existing) return json({ error: "no invite found for this email in your org" }, 404);
    if (existing.user_id) return json({ error: "user has already accepted the invite" }, 409);
  } else {
    // Insert/update the pending row first so the trigger has somewhere to link the user_id later.
    const { error: upsertErr } = await admin
      .from("org_members")
      .upsert(
        { org_id: orgId, email, role, full_name: fullName, user_id: null, app_access: appAccess, app_access_levels: appLevels },
        { onConflict: "org_id,email" },
      );
    if (upsertErr) return json({ error: `pending row: ${upsertErr.message}` }, 500);
  }

  // Make sure an auth.users row exists for the invitee — without sending
  // Supabase's default invite email (we send our own OTP email below).
  // For first-time invites this creates the row with email_confirm=false;
  // for resends or pre-existing users it's a no-op.
  try {
    const existsId = await findAuthUserIdByEmail(admin, email);
    if (!existsId) {
      await admin.auth.admin.createUser({
        email,
        email_confirm: false,
        user_metadata: full_name_meta(fullName),
      });
    }
  } catch (e) {
    // Surface real failures; "User already registered" is fine and ignored.
    const msg = (e as Error).message ?? "";
    if (!msg.toLowerCase().includes("already")) {
      return json({ error: `create user: ${msg}` }, 500);
    }
  }

  // Generate a 6-digit OTP, store its hash (otp_codes table), email it to
  // the invitee with a link to /accept-invite — the invitee enters the code
  // + a new password and the verify endpoint sets their password + flips
  // email_confirmed_at so the link_pending_org_member trigger binds them
  // to this org. Same OTP infrastructure as the signup email-verify flow.
  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  const codeHash = await sha256Hex(code);
  await admin.from("otp_codes").insert({ target: email, code_hash: codeHash });

  const acceptUrl = `${APP_URL}/accept-invite?email=${encodeURIComponent(email)}`;
  const html = /* html */`
<!DOCTYPE html>
<html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,sans-serif;color:#1a1a1a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
        <tr><td style="padding:28px 32px 0;font-weight:700;font-size:18px;color:#0f172a;">Rudrans</td></tr>
        <tr><td style="padding:20px 32px 0;">
          <h1 style="font-size:20px;margin:0 0 12px;color:#0f172a;">You've been invited</h1>
          <p style="font-size:14px;line-height:1.5;color:#475569;margin:0 0 16px;">
            ${fullName ? `Hi ${fullName.replace(/[<>&]/g, '')}, you'` : "You'"}ve been invited to join a Rudrans organization. Enter the verification code below at the link, then set your password to activate your account.
          </p>
          <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#0f172a;background:#eef2ff;padding:18px;border-radius:10px;text-align:center;font-family:monospace;">
            ${code}
          </div>
          <p style="font-size:13px;color:#475569;margin:18px 0 8px;">Verify here:</p>
          <a href="${acceptUrl}" style="display:inline-block;background:#10b981;color:#0f172a;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;font-size:14px;">Accept invitation</a>
          <p style="font-size:12px;color:#94a3b8;margin:24px 0 0;line-height:1.5;">
            The code expires in 5 minutes. Didn't expect this? You can safely ignore the email.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">
          Need help? <a href="mailto:itsupport@wellnessextract.com" style="color:#6366f1;text-decoration:none;">itsupport@wellnessextract.com</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const emailResult = await sendGraphEmail({
    to: email,
    subject: `${code} — your Rudrans invite code`,
    html,
  });
  if (!emailResult.ok) return json({ error: emailResult.error ?? "email send failed" }, 500);

  return json({ ok: true, org_id: orgId, resent: isResend, accept_url: acceptUrl });
});

function full_name_meta(fullName: string | null) {
  return fullName ? { full_name: fullName } : undefined;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
