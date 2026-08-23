// GET /functions/v1/agent-signature-fetch
// Headers: X-Agent-Token: <enroll_token>  (or Authorization: Bearer <enroll_token>)
//
// Returns the org's active signature rendered for the calling agent's user,
// so the Windows agent can drop it into `%APPDATA%\Microsoft\Signatures\` and
// set the Classic Outlook registry keys. This is the ONLY path that covers
// Classic Outlook Desktop — Microsoft's OWA-side Set-MailboxMessageConfiguration
// only reaches Classic Outlook if the tenant has cloud/roaming signatures on,
// which many customer tenants don't.
//
// User identification: agent enrolls with an agent_name (usually the person's
// full name typed during install). We match that against employees.full_name
// (case-insensitive) within the same org to find their UPN, then join to
// directory_users for M365-side fields (title, phone, etc.).
//
// Response shape:
//   {
//     enabled: false,                    // no template / no user match
//     reason?: string                    // "no_template" | "no_user_match" | "m365_not_connected"
//   }
//   OR
//   {
//     enabled: true,
//     name: "Company signature",
//     html: "<table>…</table>",
//     text: "Priya Sharma\nProduct…",
//     checksum: "sha256hex",              // agent uses this to skip writes when unchanged
//     upn: "priya@example.com"
//   }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
} as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";
  const token = xAgent || bearer;
  if (!token) return json({ error: "missing agent token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Resolve agent → org
  const { data: agent } = await admin
    .from("agents")
    .select("id, org_id, agent_name")
    .eq("enroll_token", token)
    .maybeSingle();
  if (!agent) return json({ error: "invalid token" }, 401);

  // 2. Active signature template for this org (or nothing to deploy)
  const { data: tpl } = await admin
    .from("signature_templates")
    .select("id, name, html_body")
    .eq("org_id", agent.org_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!tpl) return json({ enabled: false, reason: "no_template" });

  // 2b. Per-user gate — the agent should NOT deploy a signature unless the
  // admin has explicitly pushed to this user. We check by the agent's
  // matched employee.work_email (resolved below) against the
  // signature_push_status table. If the admin hasn't ticked this user, the
  // agent gets `enabled: false` and skips the local file write.

  // 3. Resolve agent → employee → UPN
  //
  // Match strategy (case-insensitive):
  //   a) exact `agent_name` == `employees.full_name`
  //   b) failing that, exact `agent_name` == `directory_users.display_name`
  //
  // If neither matches, we can't safely render a per-user signature (the
  // template will emit a blank name / email), so we return enabled=false
  // and the agent skips deployment until HR links the employee. Better a
  // missing signature than a wrong one.
  let workEmail: string | null = null;
  let employeeId: string | null = null;

  const { data: emp } = await admin
    .from("employees")
    .select("id, work_email, full_name, job_title, phone, department_id, org_departments(name)")
    .eq("org_id", agent.org_id)
    .ilike("full_name", agent.agent_name)
    .maybeSingle();

  let employeeRow: {
    id: string;
    work_email: string | null;
    full_name: string | null;
    job_title: string | null;
    phone: string | null;
    department_name: string | null;
  } | null = null;

  if (emp) {
    employeeId = emp.id;
    workEmail = emp.work_email;
    employeeRow = {
      id: emp.id,
      work_email: emp.work_email,
      full_name: emp.full_name,
      job_title: emp.job_title,
      phone: emp.phone,
      department_name: (emp as unknown as { org_departments: { name: string } | null }).org_departments?.name ?? null,
    };
  } else {
    // Fallback — match display_name in directory_users
    const { data: du } = await admin
      .from("directory_users")
      .select("upn")
      .eq("org_id", agent.org_id)
      .eq("provider", "m365")
      .ilike("display_name", agent.agent_name)
      .maybeSingle();
    if (du?.upn) workEmail = du.upn;
  }

  if (!workEmail) {
    return json({ enabled: false, reason: "no_user_match" });
  }

  // Enforce the per-user gate now that we know the UPN.
  const { data: pushStatus } = await admin
    .from("signature_push_status")
    .select("state")
    .eq("template_id", tpl.id)
    .ilike("upn", workEmail)
    .maybeSingle();
  if (!pushStatus || pushStatus.state !== "applied") {
    return json({ enabled: false, reason: "not_enabled_for_this_user" });
  }

  // 4. Pull directory row for token values (uses UPN as the anchor)
  const { data: du } = await admin
    .from("directory_users")
    .select(
      "upn, display_name, mail, given_name, surname, job_title, department, " +
      "office_phone, mobile_phone, office_location, city, country",
    )
    .eq("org_id", agent.org_id)
    .eq("provider", "m365")
    .eq("upn", workEmail)
    .maybeSingle();

  // 5. Company-level tokens
  const { data: org } = await admin
    .from("organizations")
    .select("name, website")
    .eq("id", agent.org_id)
    .maybeSingle();

  // 6. Render (identical logic to signatures-push edge function — kept in
  //    sync manually; small enough that duplication is cheaper than a
  //    shared helper import from Deno.serve).
  const html = renderTemplate(tpl.html_body, du, employeeRow, org?.name ?? "", org?.website ?? "", workEmail);
  const text = htmlToText(html);
  const checksum = await sha256Hex(html + "|" + text);

  // Signature entry name = employee's actual name, sanitized to be safe as a
  // Windows filename (Outlook derives the dropdown label from the filename).
  // Falls back to the agent-provided name if we can't derive one — never
  // falls back to a brand string.
  const rawName =
    employeeRow?.full_name?.trim() ||
    du?.display_name?.trim() ||
    agent.agent_name?.trim() ||
    "";
  const signatureName = sanitizeFilename(rawName) || sanitizeFilename(workEmail.split("@")[0]) || "Signature";

  return json({
    enabled: true,
    name: tpl.name,             // admin-facing template name
    signature_name: signatureName, // filename + Outlook dropdown label
    html,
    text,
    checksum,
    upn: workEmail,
    employee_id: employeeId,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering (mirror of signatures-push renderTemplate — keep in sync)
// ─────────────────────────────────────────────────────────────────────────────
function renderTemplate(
  html: string,
  du: {
    upn: string;
    display_name: string | null;
    mail: string | null;
    given_name: string | null;
    surname: string | null;
    job_title: string | null;
    department: string | null;
    office_phone: string | null;
    mobile_phone: string | null;
    office_location: string | null;
    city: string | null;
    country: string | null;
  } | null,
  emp: {
    id: string;
    work_email: string | null;
    full_name: string | null;
    job_title: string | null;
    phone: string | null;
    department_name: string | null;
  } | null,
  orgName: string,
  orgWebsite: string,
  fallbackEmail: string,
): string {
  const tokens: Record<string, string> = {
    firstName:    du?.given_name ?? emp?.full_name?.split(" ")[0] ?? "",
    lastName:     du?.surname ?? "",
    fullName:     du?.display_name ?? emp?.full_name ?? "",
    email:        du?.mail ?? du?.upn ?? emp?.work_email ?? fallbackEmail,
    title:        du?.job_title ?? emp?.job_title ?? "",
    department:   du?.department ?? emp?.department_name ?? "",
    phone:        du?.office_phone ?? emp?.phone ?? "",
    mobilePhone:  du?.mobile_phone ?? "",
    officePhone:  du?.office_phone ?? "",
    office:       du?.office_location ?? "",
    city:         du?.city ?? "",
    country:      du?.country ?? "",
    companyName:  orgName,
    website:      orgWebsite,
  };
  return html.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, key: string) => {
    const v = tokens[key] ?? "";
    return v
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  });
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip characters Windows won't accept in a filename, collapse whitespace,
 * and clamp length. The Outlook Signatures folder is on NTFS which forbids
 * `\ / : * ? " < > |` and control chars. We also drop trailing dots/spaces
 * because Explorer silently trims them and Outlook would then not find the
 * file it just wrote.
 */
function sanitizeFilename(name: string): string {
  if (!name) return "";
  return name
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 60);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
