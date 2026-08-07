// POST /functions/v1/signatures-push
//
// Push a rendered Outlook signature into each selected user's mailbox by
// invoking Exchange Online's PowerShell REST endpoint. Runs
// `Set-MailboxMessageConfiguration` per user with SignatureHtml +
// SignatureText + AutoAdd flags — the same command customer IT admins run
// manually today. Applies to Outlook Web + New Outlook immediately; classic
// desktop Outlook picks it up if the tenant has cloud/roaming signatures on.
//
// Body:
//   {
//     template_id: uuid,                                 // required
//     employee_ids?: uuid[] | 'all',                     // default 'all'
//     org_id?: uuid                                      // resolved from JWT if omitted
//   }
//
// Auth: user JWT (owner/admin of the org) OR service-role bearer.
//
// Concurrency: 6-way in parallel — Exchange REST rate-limits at ~10 rps for
// admin cmdlets. Higher concurrency triggers throttling (503 with
// X-Ms-Diagnostics: "microsoft.exchange.data.storage.throttling").

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsFor } from "../_shared/cors.ts";
import { exchangeTokenFor } from "../_shared/graph.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;

const PUSH_CONCURRENCY = 6;

type Body = {
  template_id: string;
  employee_ids?: string[] | "all";
  org_id?: string;
};

interface DirectoryUser {
  external_id: string | null;
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
  raw: Record<string, unknown> | null;
}

interface EmployeeLite {
  id: string;
  work_email: string | null;
  full_name: string | null;
  job_title: string | null;
  phone: string | null;
  department_name: string | null;
}

const json = (body: unknown, status = 200, cors: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

  const authHeader = req.headers.get("authorization") ?? "";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isServiceRole = authHeader.replace(/^Bearer\s+/i, "") === SERVICE_ROLE_KEY;

  let body: Body;
  try { body = await req.json() as Body; } catch { return json({ error: "invalid json" }, 400, cors); }
  if (!body.template_id) return json({ error: "template_id required" }, 400, cors);

  // ────────────────────────────────────────────────────────────────────────
  // 1. Load template + resolve org
  // ────────────────────────────────────────────────────────────────────────
  const { data: tpl, error: tplErr } = await admin
    .from("signature_templates")
    .select("id, org_id, html_body, auto_add_new_message, auto_add_reply_forward, auto_add_mobile, is_active")
    .eq("id", body.template_id)
    .maybeSingle();
  if (tplErr || !tpl) return json({ error: "template not found" }, 404, cors);

  const orgId = body.org_id ?? tpl.org_id;
  if (orgId !== tpl.org_id) return json({ error: "template does not belong to this org" }, 403, cors);

  // Caller check (non-service-role paths only)
  if (!isServiceRole) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return json({ error: "invalid token" }, 401, cors);
    const { data: mem } = await admin
      .from("org_members")
      .select("role")
      .eq("user_id", u.user.id)
      .eq("org_id", orgId)
      .in("role", ["owner", "admin"])
      .maybeSingle();
    if (!mem) return json({ error: "must be owner/admin of the org" }, 403, cors);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 2. Resolve target user set
  // ────────────────────────────────────────────────────────────────────────
  // Join directory_users to employees so we can render employee-side fields
  // (phone, department name from `org_departments`) that live outside the
  // directory sync.
  let dirQ = admin
    .from("directory_users")
    .select(
      "external_id, upn, display_name, mail, given_name, surname, job_title, department, " +
      "office_phone, mobile_phone, office_location, city, country, raw",
    )
    .eq("org_id", orgId)
    .eq("provider", "m365")
    .eq("account_enabled", true);

  if (body.employee_ids && body.employee_ids !== "all") {
    // Map employee_ids → their m365 UPN via the employees table's work_email.
    // (directory_users has no employee_id column — join is via UPN/email.)
    if (body.employee_ids.length === 0) return json({ pushed: 0, results: [] }, 200, cors);
    const { data: emps } = await admin
      .from("employees")
      .select("work_email")
      .eq("org_id", orgId)
      .in("id", body.employee_ids);
    const upns = (emps ?? []).map((e) => e.work_email).filter(Boolean) as string[];
    if (upns.length === 0) return json({ error: "no matching M365 users for those employees" }, 400, cors);
    dirQ = dirQ.in("upn", upns);
  }

  const { data: dirUsers, error: dirErr } = await dirQ;
  if (dirErr) return json({ error: `directory query: ${dirErr.message}` }, 500, cors);
  if (!dirUsers || dirUsers.length === 0) {
    return json({ error: "no active M365 users found for this org" }, 400, cors);
  }

  // Pull matching employee rows to enrich token rendering.
  const upns = dirUsers.map((u) => u.upn).filter(Boolean);
  const { data: employees } = await admin
    .from("employees")
    .select("id, work_email, full_name, job_title, phone, department_id, org_departments(name)")
    .eq("org_id", orgId)
    .in("work_email", upns);
  const empByUpn = new Map<string, EmployeeLite>();
  for (const e of (employees ?? []) as unknown as Array<
    EmployeeLite & { department_id: string | null; org_departments: { name: string } | null }
  >) {
    if (!e.work_email) continue;
    empByUpn.set(e.work_email.toLowerCase(), {
      id: e.id,
      work_email: e.work_email,
      full_name: e.full_name,
      job_title: e.job_title,
      phone: e.phone,
      department_name: e.org_departments?.name ?? null,
    });
  }

  // Company-level tokens (name, website) from organizations.
  const { data: org } = await admin
    .from("organizations")
    .select("name, website")
    .eq("id", orgId)
    .maybeSingle();

  // ────────────────────────────────────────────────────────────────────────
  // 3. Mint Exchange token (once) and loop through users
  // ────────────────────────────────────────────────────────────────────────
  let exchangeToken: string;
  let tenantId: string;
  try {
    const t = await exchangeTokenFor(orgId);
    exchangeToken = t.accessToken;
    tenantId = t.tenantId;
  } catch (e) {
    return json({ error: (e as Error).message, error_code: "exchange_auth_failed" }, 502, cors);
  }

  const results: Array<{ upn: string; state: string; error?: string }> = [];
  await runPool(dirUsers as DirectoryUser[], PUSH_CONCURRENCY, async (du) => {
    const emp = empByUpn.get(du.upn.toLowerCase());
    const rendered = renderTemplate(tpl.html_body, du, emp, org?.name ?? "", org?.website ?? "");
    const textFallback = htmlToText(rendered);

    // Mark as pending BEFORE the network call so a mid-push crash doesn't
    // leave rows in a permanently-unknown state.
    await upsertStatus(admin, {
      template_id: tpl.id,
      org_id: orgId,
      employee_id: emp?.id ?? null,
      upn: du.upn,
      state: "pending",
      error: null,
    });

    try {
      await pushOneSignature({
        exchangeToken,
        tenantId,
        upn: du.upn,
        signatureHtml: rendered,
        signatureText: textFallback,
        autoAddNewMessage: tpl.auto_add_new_message,
        autoAddReplyForward: tpl.auto_add_reply_forward,
        autoAddMobile: tpl.auto_add_mobile,
      });
      await upsertStatus(admin, {
        template_id: tpl.id,
        org_id: orgId,
        employee_id: emp?.id ?? null,
        upn: du.upn,
        state: "applied",
        error: null,
      });
      results.push({ upn: du.upn, state: "applied" });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await upsertStatus(admin, {
        template_id: tpl.id,
        org_id: orgId,
        employee_id: emp?.id ?? null,
        upn: du.upn,
        state: "failed",
        error: msg,
      });
      results.push({ upn: du.upn, state: "failed", error: msg });
    }
  });

  const applied = results.filter((r) => r.state === "applied").length;
  const failed  = results.filter((r) => r.state === "failed").length;

  // ────────────────────────────────────────────────────────────────────────
  // Realtime broadcast — tell every Windows agent whose employee matched a
  // pushed UPN to fetch + deploy locally. Classic Outlook Desktop can only
  // be reached this way (Exchange REST doesn't touch %APPDATA%\Signatures
  // unless the tenant has cloud/roaming signatures on). Broadcast is
  // fire-and-forget — Realtime's transient delivery is fine because a fresh
  // agent process re-deploys on next Realtime reconnect anyway.
  // ────────────────────────────────────────────────────────────────────────
  const pushedUpns = results.filter((r) => r.state === "applied").map((r) => r.upn);
  if (pushedUpns.length > 0) {
    try {
      const { data: matchedAgents } = await admin
        .from("agents")
        .select("id, agent_name, os_type")
        .eq("org_id", orgId)
        .ilike("os_type", "windows%");
      // Filter agents whose display name matches any of the pushed users.
      // We join on employees.full_name (same rule as agent-signature-fetch)
      // so agents whose employee row hasn't been created yet get skipped.
      const { data: matchedEmps } = await admin
        .from("employees")
        .select("full_name, work_email")
        .eq("org_id", orgId)
        .in("work_email", pushedUpns);
      const empNames = new Set((matchedEmps ?? []).map((e) => (e.full_name ?? "").toLowerCase().trim()));
      const targetAgents = (matchedAgents ?? []).filter(
        (a) => empNames.has((a.agent_name ?? "").toLowerCase().trim()),
      );
      await Promise.all(targetAgents.map(async (a) => {
        try {
          const ch = admin.channel(`agent:${a.id}`);
          await ch.send({
            type: "broadcast",
            event: "signature.push",
            payload: { template_id: tpl.id, at: new Date().toISOString() },
          });
          await admin.removeChannel(ch);
        } catch (err) {
          console.warn(`[signatures-push] broadcast to agent ${a.id} failed: ${(err as Error).message}`);
        }
      }));
    } catch (err) {
      // Broadcast failure doesn't fail the push — OWA already applied,
      // agents will pick up on their next Realtime reconnect anyway.
      console.warn(`[signatures-push] realtime broadcast wrapper failed: ${(err as Error).message}`);
    }
  }

  return json({ pushed: applied, failed, total: results.length, results }, 200, cors);
});

// ─────────────────────────────────────────────────────────────────────────────
// Signature template rendering
//
// Tokens supported (case-insensitive around the braces, but token itself is
// camelCase). Missing values collapse to an empty string so no "{{undefined}}"
// leaks into a customer's mailbox.
// ─────────────────────────────────────────────────────────────────────────────
function renderTemplate(
  html: string,
  du: DirectoryUser,
  emp: EmployeeLite | undefined,
  orgName: string,
  orgWebsite: string,
): string {
  const tokens: Record<string, string> = {
    firstName:    du.given_name ?? emp?.full_name?.split(" ")[0] ?? "",
    lastName:     du.surname ?? "",
    fullName:     du.display_name ?? emp?.full_name ?? "",
    email:        du.mail ?? du.upn ?? emp?.work_email ?? "",
    title:        du.job_title ?? emp?.job_title ?? "",
    department:   du.department ?? emp?.department_name ?? "",
    phone:        du.office_phone ?? emp?.phone ?? "",
    mobilePhone:  du.mobile_phone ?? "",
    officePhone:  du.office_phone ?? "",
    office:       du.office_location ?? "",
    city:         du.city ?? "",
    country:      du.country ?? "",
    companyName:  orgName,
    website:      orgWebsite,
  };
  return html.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, key: string) => {
    const v = tokens[key] ?? "";
    // HTML-escape so a user with `<script>` in their display_name can't XSS
    // an admin who previews the rendered signature.
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

// ─────────────────────────────────────────────────────────────────────────────
// Exchange PowerShell REST — Set-MailboxMessageConfiguration
//
// Doc: https://learn.microsoft.com/powershell/module/exchange/set-mailboxmessageconfiguration
// REST envelope: https://learn.microsoft.com/graph/exchange-online-rest-api
//
// Endpoint shape:
//   POST https://outlook.office365.com/adminapi/beta/{tenantId}/InvokeCommand
//   Authorization: Bearer <Exchange token>
//   Content-Type: application/json
//   Body: { "CmdletInput": { "CmdletName": "Set-MailboxMessageConfiguration",
//                            "Parameters": { "Identity": "...", ... } } }
// ─────────────────────────────────────────────────────────────────────────────
async function pushOneSignature(args: {
  exchangeToken: string;
  tenantId: string;
  upn: string;
  signatureHtml: string;
  signatureText: string;
  autoAddNewMessage: boolean;
  autoAddReplyForward: boolean;
  autoAddMobile: boolean;
}) {
  const url = `https://outlook.office365.com/adminapi/beta/${args.tenantId}/InvokeCommand`;
  const payload = {
    CmdletInput: {
      CmdletName: "Set-MailboxMessageConfiguration",
      Parameters: {
        Identity: args.upn,
        SignatureHtml: args.signatureHtml,
        SignatureText: args.signatureText,
        // Mobile OWA parameter is separate — Exchange treats it as a distinct
        // string so users get a plain-text signature on the Outlook mobile
        // signature-line even if HTML rendering is disabled.
        SignatureTextOnMobileOWA: args.signatureText,
        AutoAddSignature: args.autoAddNewMessage,
        AutoAddSignatureOnReply: args.autoAddReplyForward,
        AutoAddSignatureOnMobile: args.autoAddMobile,
      },
    },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.exchangeToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    // Exchange returns 4xx JSON envelopes with the actual failure buried in
    // `error.details[0].message`. Try to extract; fall back to raw body.
    let msg = txt;
    try {
      const j = JSON.parse(txt);
      msg = j?.error?.message
        ?? j?.error?.details?.[0]?.message
        ?? txt;
    } catch { /* keep raw */ }
    throw new Error(`Exchange ${resp.status}: ${msg.slice(0, 400)}`);
  }
}

async function upsertStatus(admin: ReturnType<typeof createClient>, row: {
  template_id: string;
  org_id: string;
  employee_id: string | null;
  upn: string;
  state: "pending" | "applied" | "failed" | "skipped";
  error: string | null;
}) {
  await admin.from("signature_push_status").upsert(
    {
      template_id: row.template_id,
      org_id: row.org_id,
      employee_id: row.employee_id,
      upn: row.upn,
      state: row.state,
      applied_at: row.state === "applied" ? new Date().toISOString() : null,
      last_error: row.error,
      attempts: row.state === "pending" ? 0 : 1,
    },
    { onConflict: "template_id,upn", ignoreDuplicates: false },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small concurrency helper (Promise.all fanning is too aggressive — 100 users
// × unbounded concurrency triggers Exchange 429s within seconds).
// ─────────────────────────────────────────────────────────────────────────────
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
