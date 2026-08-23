// GET /functions/v1/outlook-addin-signature?upn=<user_upn>
//
// Called by the Wellness Extract Outlook add-in (Office.js) when a user
// starts a new message, reply, or forward. Returns the rendered signature
// HTML for THAT user, so the add-in can inject it into the compose body
// via Office.context.mailbox.item.body.setSignatureAsync().
//
// Auth: public anon key + apikey header. The UPN is trusted from Office
// context (the add-in only runs in the user's own Outlook session, so a
// mismatched UPN would be from someone reverse-engineering the endpoint —
// and even then, signature HTML is not sensitive; it's what goes on every
// outgoing mail anyway).
//
// Response — same shape as agent-signature-fetch:
//   { enabled: false, reason?: string }
//   OR
//   { enabled: true, name, html, upn }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The add-in fetches from a user's Outlook context; CORS ACAO=* is required
// because the origin varies (outlook.office.com, outlook.live.com, etc.)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
} as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  const url = new URL(req.url);
  const upn = url.searchParams.get("upn")?.trim().toLowerCase();
  if (!upn) return json({ error: "upn query param required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Resolve user's org via their directory_users row.
  const { data: du } = await admin
    .from("directory_users")
    .select(
      "org_id, upn, display_name, mail, given_name, surname, job_title, department, " +
      "office_phone, mobile_phone, office_location, city, country",
    )
    .ilike("upn", upn)
    .eq("provider", "m365")
    .maybeSingle();

  if (!du || !du.org_id) {
    return json({ enabled: false, reason: "no_directory_row" });
  }

  // 2. Fetch org's active signature template.
  const { data: tpl } = await admin
    .from("signature_templates")
    .select("id, name, html_body")
    .eq("org_id", du.org_id)
    .eq("is_active", true)
    .maybeSingle();

  if (!tpl) return json({ enabled: false, reason: "no_template" });

  // 2b. Per-user gate — only return the signature if the admin has
  // explicitly pushed to THIS user (i.e. a signature_push_status row
  // with state='applied' exists). Otherwise the org-wide add-in rollout
  // would auto-enable everyone the moment the admin creates a template,
  // which the customer specifically doesn't want.
  const { data: status } = await admin
    .from("signature_push_status")
    .select("state")
    .eq("template_id", tpl.id)
    .ilike("upn", upn)
    .maybeSingle();
  if (!status || status.state !== "applied") {
    return json({ enabled: false, reason: "not_enabled_for_this_user" });
  }

  // 3. Enrich with employees row if available (may add phone / job title
  //    that isn't in the directory sync).
  const { data: emp } = await admin
    .from("employees")
    .select("full_name, job_title, phone, department_id, org_departments(name)")
    .eq("org_id", du.org_id)
    .ilike("work_email", upn)
    .maybeSingle();

  const empRow = emp as unknown as {
    full_name: string | null;
    job_title: string | null;
    phone: string | null;
    org_departments: { name: string } | null;
  } | null;

  // 4. Company-level tokens.
  const { data: org } = await admin
    .from("organizations")
    .select("name, website")
    .eq("id", du.org_id)
    .maybeSingle();

  // 5. Render.
  const html = renderTemplate(
    tpl.html_body,
    du,
    empRow,
    org?.name ?? "",
    org?.website ?? "",
  );

  return json({
    enabled: true,
    name: tpl.name,
    html,
    upn: du.upn,
  });
});

/**
 * Same token map as signatures-push + agent-signature-fetch. Kept in sync
 * manually — small enough that duplication is cheaper than a shared import.
 */
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
  },
  emp: {
    full_name: string | null;
    job_title: string | null;
    phone: string | null;
    org_departments: { name: string } | null;
  } | null,
  orgName: string,
  orgWebsite: string,
): string {
  const tokens: Record<string, string> = {
    firstName:   du.given_name ?? emp?.full_name?.split(" ")[0] ?? "",
    lastName:    du.surname ?? "",
    fullName:    du.display_name ?? emp?.full_name ?? "",
    email:       du.mail ?? du.upn,
    title:       du.job_title ?? emp?.job_title ?? "",
    department:  du.department ?? emp?.org_departments?.name ?? "",
    phone:       du.office_phone ?? emp?.phone ?? "",
    mobilePhone: du.mobile_phone ?? "",
    officePhone: du.office_phone ?? "",
    office:      du.office_location ?? "",
    city:        du.city ?? "",
    country:     du.country ?? "",
    companyName: orgName,
    website:     orgWebsite,
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
