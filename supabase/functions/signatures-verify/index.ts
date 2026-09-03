// POST /functions/v1/signatures-verify
// Body: { upn: string }
// Reads the current mailbox message configuration for one user from
// Exchange Online (via Get-MailboxMessageConfiguration InvokeCommand) so
// the admin can see what Exchange ACTUALLY stored, distinguishing three
// distinct outcomes:
//
//   1. Signature present + non-empty  → push landed on the server; if the
//      user still sees "empty" in OWA/Outlook, it's a client-side issue
//      (wrong account signed in, stale cache, roaming-signatures store
//      not linked, etc.). This is the common case that used to confuse
//      admins into re-pushing endlessly.
//   2. Signature missing / empty      → push never took effect. Admin
//      needs to re-push and check the previous attempt's error.
//   3. User not found on Exchange     → the UPN is wrong or the tenant
//      doesn't host that mailbox.
//
// Auth: user JWT (admin only) — same pattern as signatures-push.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { exchangeTokenFor } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const cors = corsHeaders;
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) return json({ error: "missing bearer token" }, 401, cors);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: u } = await admin.auth.getUser(bearer);
  if (!u?.user) return json({ error: "invalid token" }, 401, cors);

  let body: { upn?: string };
  try { body = await req.json(); }
  catch { return json({ error: "invalid json" }, 400, cors); }
  const upn = body.upn?.trim();
  if (!upn) return json({ error: "upn required" }, 400, cors);

  // Resolve org from caller's membership. Admin/owner only.
  const { data: member } = await admin
    .from("org_members")
    .select("org_id, role")
    .eq("user_id", u.user.id)
    .maybeSingle();
  if (!member || !["owner", "admin", "super_admin"].includes(member.role)) {
    return json({ error: "not authorised" }, 403, cors);
  }

  // Mint Exchange token for the caller's org tenant.
  let exchangeToken: string;
  let tenantId: string;
  try {
    const t = await exchangeTokenFor(member.org_id);
    exchangeToken = t.accessToken;
    tenantId = t.tenantId;
  } catch (e) {
    return json({
      error: `exchange token failed: ${(e as Error).message}`,
      hint: "Check that org_integrations has a valid Microsoft 365 admin-consent for this org.",
    }, 500, cors);
  }

  // Get-MailboxMessageConfiguration returns the signature values currently
  // stored on the mailbox. This is the SAME field Set-MailboxMessageConfig-
  // uration writes to, so it's the authoritative "did the push land" check
  // for Classic Outlook desktop.
  const url = `https://outlook.office365.com/adminapi/beta/${tenantId}/InvokeCommand`;
  const payload = {
    CmdletInput: {
      CmdletName: "Get-MailboxMessageConfiguration",
      Parameters: { Identity: upn },
    },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${exchangeToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const rawText = await resp.text();
  if (!resp.ok) {
    let msg = rawText;
    try {
      const j = JSON.parse(rawText);
      msg = j?.error?.message ?? j?.error?.details?.[0]?.message ?? rawText;
    } catch { /* keep raw */ }
    return json({ error: `Exchange ${resp.status}: ${msg.slice(0, 400)}` }, 502, cors);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); }
  catch { return json({ error: "Exchange returned non-JSON", raw: rawText.slice(0, 400) }, 502, cors); }

  // Exchange REST wraps output as { value: [ {...} ] } when the cmdlet
  // returns a single row.
  const row = (parsed as { value?: Array<Record<string, unknown>> }).value?.[0]
    ?? (parsed as Record<string, unknown>);
  const html = String(row?.SignatureHtml ?? "");
  const text = String(row?.SignatureText ?? "");
  const name = String(row?.SignatureName ?? "");
  const defaultSignature = String(row?.DefaultSignature ?? "");
  const defaultOnReply = String(row?.DefaultSignatureOnReply ?? "");
  const autoAddNew = Boolean(row?.AutoAddSignature);
  const autoAddReply = Boolean(row?.AutoAddSignatureOnReply);
  const hasHtml = html.trim().length > 0;
  const hasText = text.trim().length > 0;
  const configured = hasHtml || hasText;

  return json({
    upn,
    configured,
    has_html: hasHtml,
    has_text: hasText,
    signature_name: name,
    default_signature: defaultSignature,
    default_signature_on_reply: defaultOnReply,
    auto_add_new: autoAddNew,
    auto_add_reply: autoAddReply,
    html_preview: html.slice(0, 1000),
    text_preview: text.slice(0, 500),
    // Give the admin an actionable next-step summary.
    diagnosis: configured
      ? "Exchange DOES have the signature stored for this user. If the user sees an empty signature in OWA / New Outlook, the client is likely looking at the Roaming Signatures store rather than the legacy field, which needs the Outlook Add-in to be installed in the tenant. Classic Outlook desktop reads this field directly and will show the signature after next launch."
      : "Exchange does NOT have a signature stored for this user. The last push either failed or was never sent. Re-push from the template page.",
  }, 200, cors);
});

function json(body: unknown, status = 200, cors: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
