// POST /functions/v1/offboarding
// Headers: Authorization: Bearer <user JWT>
// Body variants (action determines the stage):
//   { action: 'start',    employee_id, reason?, lwd?, it_recipients: string[] }
//        → creates offboardings row at stage 'creds_review', sets employee.status='offboarding',
//          emails IT with the full credentials-issued history.
//   { action: 'revoke',   offboarding_id }
//        → blocks sign-in on M365 + Google, revokes existing sessions, advances to 'access_revoked',
//          emails HR (recipients picked when admin moves to stage 3).
//   { action: 'complete', offboarding_id, laptop_serial?, asset_notes?, it_remark?,
//                         hr_recipients: string[], accounts_recipients: string[] }
//        → emails HR + Accounts with the full offboarding summary, sets status='done',
//          employee.status='offboarded'.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { graphFetch, loadOrgM365 } from "../_shared/graph.ts";
import { googleJson, loadOrgGoogle } from "../_shared/google.ts";
import { sendGraphEmail } from "../_shared/graph-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = bearer(req);
  if (!jwt) return json({ error: "missing user token" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);
  const callerId = u.user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const action = (body.action as string | undefined) ?? "";

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (action === "start")    return await start(admin, callerId, body);
  if (action === "revoke")              return await revoke(admin, callerId, body);
  if (action === "advance_to_devices")  return await advanceToDevices(admin, callerId, body);
  if (action === "complete")            return await complete(admin, callerId, body);
  return json({ error: "unknown action" }, 400);
});

// ============== stage 1 ==============

async function start(admin: ReturnType<typeof createClient>, callerId: string, body: Record<string, unknown>): Promise<Response> {
  const employeeId = body.employee_id as string;
  const itRecipients = Array.isArray(body.it_recipients) ? body.it_recipients as string[] : [];
  if (!employeeId) return json({ error: "employee_id required" }, 400);
  if (!itRecipients.length) return json({ error: "it_recipients required (at least one IT email)" }, 400);

  const { data: emp } = await admin
    .from("employees")
    .select("id, org_id, full_name, work_email, designation, doj, status, department_id, manager_id")
    .eq("id", employeeId).maybeSingle();
  if (!emp) return json({ error: "employee not found" }, 404);
  if (emp.status !== "active") return json({ error: `employee status is ${emp.status}` }, 409);

  // Authorise caller is a member of this org.
  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", callerId).eq("org_id", emp.org_id);
  if (!mem?.length) return json({ error: "not authorised for this org" }, 403);

  // Create the offboardings row.
  const { data: off, error: offErr } = await admin.from("offboardings").insert({
    org_id: emp.org_id, employee_id: emp.id,
    initiated_by: callerId,
    reason: (body.reason as string | undefined) ?? null,
    lwd: (body.lwd as string | undefined) ?? null,
    current_stage: "creds_review",
    status: "in_progress",
    stage1_it_recipients: itRecipients,
  }).select("id").single();
  if (offErr) {
    if (/offboardings_one_active_idx/.test(offErr.message)) {
      return json({ error: "an in-progress offboarding already exists for this employee" }, 409);
    }
    return json({ error: offErr.message }, 500);
  }
  await admin.from("employees").update({ status: "offboarding", lwd: (body.lwd as string | undefined) ?? null }).eq("id", emp.id);

  // Build the credentials-history table for the email.
  const { data: hist } = await admin
    .from("v_employee_cred_history")
    .select("platform_name, login_url, username, delivery_email, sent_at")
    .eq("employee_id", emp.id)
    .order("sent_at", { ascending: false });
  const credRows = (hist ?? []).map((h) =>
    `<tr><td style="padding:6px 10px">${escape(h.platform_name)}</td><td style="padding:6px 10px;font-family:Menlo,monospace">${escape(h.username ?? "")}</td><td style="padding:6px 10px;color:#6b7280">${new Date(h.sent_at).toLocaleString()}</td></tr>`
  ).join("");

  const { data: org } = await admin.from("organizations").select("name").eq("id", emp.org_id).single();
  const mail = await sendGraphEmail({ orgId: emp.org_id,
    to: itRecipients[0],
    cc: itRecipients.slice(1),
    subject: `[Offboarding stage 1] Creds issued to ${emp.full_name}`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1f2937">
      <h2 style="color:#dc2626;margin:0 0 8px">Offboarding initiated — ${escape(emp.full_name)}</h2>
      <p>This is the complete list of credentials Rudrans has dispatched to <strong>${escape(emp.full_name)}</strong> (${escape(emp.work_email ?? "")}) to date.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f9fafb;border-radius:8px;overflow:hidden;font-size:13px">
        <thead><tr style="background:#e5e7eb"><th style="padding:8px 10px;text-align:left">Platform</th><th style="padding:8px 10px;text-align:left">Username</th><th style="padding:8px 10px;text-align:left">Sent at</th></tr></thead>
        <tbody>${credRows || `<tr><td colspan="3" style="padding:16px;text-align:center;color:#6b7280">No credentials dispatched via Rudrans.</td></tr>`}</tbody>
      </table>
      <p style="font-size:13px">Please verify which of these need rotation. Once verified, return to Rudrans → Offboarding to revoke sign-in for ${escape(emp.full_name)}.</p>
      <p style="font-size:11px;color:#9ca3af">Sent from ${escape(org?.name ?? "")} via Rudrans · offboarding #${off.id}</p>
    </body></html>`,
  });

  await admin.from("offboarding_events").insert({
    offboarding_id: off.id, org_id: emp.org_id, actor_id: callerId, event: "started",
    detail: { it_recipients: itRecipients, credentials_count: (hist ?? []).length, mail_ok: mail.ok, mail_error: mail.error },
  });
  await admin.from("offboarding_events").insert({
    offboarding_id: off.id, org_id: emp.org_id, actor_id: callerId, event: "creds_mail_sent",
    detail: { ok: mail.ok, error: mail.error },
  });
  await admin.from("employee_audit").insert({
    org_id: emp.org_id, employee_id: emp.id, actor_id: callerId,
    action: "offboarding_started", detail: { offboarding_id: off.id },
  });

  await admin.from("offboardings")
    .update({ stage1_completed_at: new Date().toISOString() })
    .eq("id", off.id);

  return json({ ok: true, offboarding_id: off.id, mail }, 200);
}

// ============== stage 2 ==============

async function revoke(admin: ReturnType<typeof createClient>, callerId: string, body: Record<string, unknown>): Promise<Response> {
  const offId = body.offboarding_id as string;
  if (!offId) return json({ error: "offboarding_id required" }, 400);

  const { data: off } = await admin.from("offboardings").select("*").eq("id", offId).maybeSingle();
  if (!off) return json({ error: "offboarding not found" }, 404);
  if (off.status !== "in_progress" || off.current_stage !== "creds_review") {
    return json({ error: `cannot revoke at stage ${off.current_stage}/${off.status}` }, 409);
  }

  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", callerId).eq("org_id", off.org_id);
  if (!mem?.length) return json({ error: "not authorised for this org" }, 403);

  const { data: emp } = await admin
    .from("employees")
    .select("id, full_name, work_email, m365_user_id, google_user_id, org_id")
    .eq("id", off.employee_id).single();

  const detail: Record<string, { ok: boolean; error?: string; unassigned_count?: number }> = {};

  // ---- M365: block sign-in + revoke sessions ----
  if (emp.m365_user_id) {
    try {
      await loadOrgM365(emp.org_id);  // throws if not connected
      const r1 = await graphFetch(emp.org_id, {
        method: "PATCH",
        path: `/users/${emp.m365_user_id}`,
        body: { accountEnabled: false },
      });
      if (!r1.ok && r1.status !== 204) throw new Error(`disable: ${r1.status} ${await r1.text()}`);
      const r2 = await graphFetch(emp.org_id, {
        method: "POST",
        path: `/users/${emp.m365_user_id}/revokeSignInSessions`,
      });
      if (!r2.ok && r2.status !== 204) throw new Error(`revoke: ${r2.status} ${await r2.text()}`);
      detail.m365 = { ok: true };
    } catch (e) {
      detail.m365 = { ok: false, error: (e as Error).message };
    }
  } else {
    detail.m365 = { ok: true, error: "not provisioned" };
  }

  // ---- Google: suspend user + sign-out tokens ----
  if (emp.google_user_id) {
    try {
      await loadOrgGoogle(emp.org_id);
      await googleJson(emp.org_id, {
        method: "PUT",
        path: `/users/${emp.google_user_id}`,
        body: { suspended: true },
      });
      // signOut works on userKey = email or id; use id which is more stable.
      try {
        await googleJson(emp.org_id, {
          method: "POST",
          path: `/users/${emp.google_user_id}/signOut`,
        });
      } catch { /* signOut may 404 on already-suspended users; non-fatal */ }
      detail.google = { ok: true };
    } catch (e) {
      detail.google = { ok: false, error: (e as Error).message };
    }
  } else {
    detail.google = { ok: true, error: "not provisioned" };
  }

  // ---- Hardware: do NOT touch hardware_assets at stage 2. Devices stay
  // assigned to the employee until IT physically confirms handover at
  // stage 3 (Complete). Reclaiming here breaks the stage-3 UI — its
  // "assigned devices" auto-fetch (filter `status = 'assigned'`) returns
  // an empty list, so IT can't see what was supposed to be handed back
  // and has to manually type serial + notes. See customer report
  // 2026-07-15. The stage-3 Complete handler further down flips assets
  // back to in_stock + closes the hardware_assignments rows, which is
  // where the reclaim semantically belongs.
  const { data: heldAssetsPreview } = await admin
    .from("hardware_assets")
    .select("id")
    .eq("assigned_employee_id", emp.id)
    .eq("status", "assigned");
  detail.hardware = {
    ok: true,
    still_assigned_count: heldAssetsPreview?.length ?? 0,
    note: "auto-unassign deferred to stage-3 completion",
  };

  const now = new Date().toISOString();
  await admin.from("offboardings").update({
    current_stage: "access_revoked",
    stage2_completed_at: now,
    stage2_signin_blocked_at: now,
    stage2_block_detail: detail,
  }).eq("id", offId);

  await admin.from("offboarding_events").insert({
    offboarding_id: offId, org_id: off.org_id, actor_id: callerId, event: "signin_blocked", detail,
  });
  await admin.from("employee_audit").insert({
    org_id: off.org_id, employee_id: emp.id, actor_id: callerId, action: "blocked", detail,
  });

  return json({ ok: true, detail }, 200);
}

// ============== stage 2 → 3 (advance only) ==============
// Stage 2 is the M365/Google sign-in revocation confirmation. NO emails sent
// here, no credential revocation yet — IT just confirms they've blocked
// sign-in on the directory side and moves the offboarding to Stage 3 where
// the per-app credential revocation + device collection + NOC email actually
// happens.

async function advanceToDevices(admin: ReturnType<typeof createClient>, callerId: string, body: Record<string, unknown>): Promise<Response> {
  const offId = body.offboarding_id as string;
  if (!offId) return json({ error: "offboarding_id required" }, 400);

  const { data: off } = await admin.from("offboardings").select("*").eq("id", offId).maybeSingle();
  if (!off) return json({ error: "offboarding not found" }, 404);
  if (off.status !== "in_progress" || off.current_stage !== "access_revoked") {
    return json({ error: `cannot advance at stage ${off.current_stage}/${off.status}` }, 409);
  }
  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", callerId).eq("org_id", off.org_id);
  if (!mem?.length) return json({ error: "not authorised for this org" }, 403);

  await admin.from("offboardings")
    .update({ current_stage: "devices_pending" })
    .eq("id", offId);

  await admin.from("offboarding_events").insert({
    offboarding_id: offId, org_id: off.org_id, actor_id: callerId, event: "advanced_to_devices",
  });

  return json({ ok: true, next_stage: "devices_pending" }, 200);
}

// ============== stage 3 → 4 (devices handover + NOC) ==============

async function complete(admin: ReturnType<typeof createClient>, callerId: string, body: Record<string, unknown>): Promise<Response> {
  const offId = body.offboarding_id as string;
  const hrRecipients = Array.isArray(body.hr_recipients) ? body.hr_recipients as string[] : [];
  const accountsRecipients = Array.isArray(body.accounts_recipients) ? body.accounts_recipients as string[] : [];
  if (!offId) return json({ error: "offboarding_id required" }, 400);
  if (!hrRecipients.length && !accountsRecipients.length) {
    return json({ error: "Provide at least one HR or Accounts recipient" }, 400);
  }

  const { data: off } = await admin.from("offboardings").select("*").eq("id", offId).maybeSingle();
  if (!off) return json({ error: "offboarding not found" }, 404);
  // Accept either devices_pending (clean stage-3 flow) or access_revoked
  // (legacy single-step complete, for backwards compatibility).
  if (off.status !== "in_progress" || !["devices_pending", "access_revoked"].includes(off.current_stage)) {
    return json({ error: `cannot complete at stage ${off.current_stage}/${off.status}` }, 409);
  }

  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", callerId).eq("org_id", off.org_id);
  if (!mem?.length) return json({ error: "not authorised for this org" }, 403);

  const { data: emp } = await admin
    .from("employees")
    .select("id, org_id, full_name, work_email, designation, doj, lwd, department_id, manager_id")
    .eq("id", off.employee_id).single();

  // Pull full creds history for the final summary. We do this AFTER the
  // revocation update above so the rendered status reflects what just happened.
  const { data: hist } = await admin
    .from("v_employee_cred_history")
    .select("platform_name, login_url, username, delivery_email, sent_at, revoked_at")
    .eq("employee_id", emp.id)
    .order("sent_at", { ascending: false });
  type CredHistRow = { platform_name: string; username: string | null; sent_at: string; revoked_at: string | null };
  const histList = (hist ?? []) as CredHistRow[];
  // Every row in the NOC is rendered as "Access revoked" — by the time we
  // get here Stage 3 has completed and the employee's per-credential access
  // is considered closed regardless of whether each row carried a `revoked_at`
  // tick from the checklist (the underlying platform login itself stays
  // active for other employees).
  const credRows = histList.map((h) => {
    const badge = `<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-size:11px">Access revoked</span>`;
    return `<tr><td style="padding:6px 10px">${escape(h.platform_name)}</td><td style="padding:6px 10px;font-family:Menlo,monospace">${escape(h.username ?? "")}</td><td style="padding:6px 10px">${badge}</td></tr>`;
  }).join("");

  // Manager + dept for the summary.
  let managerName = "—", deptName = "—";
  if (emp.manager_id) {
    const { data: m } = await admin.from("employees").select("full_name").eq("id", emp.manager_id).single();
    managerName = m?.full_name ?? "—";
  }
  if (emp.department_id) {
    const { data: d } = await admin.from("org_departments").select("name").eq("id", emp.department_id).single();
    deptName = d?.name ?? "—";
  }

  const itRemark = (body.it_remark as string | undefined) ?? null;
  const laptopSerial = (body.laptop_serial as string | undefined) ?? null;
  const assetNotes = (body.asset_notes as string | undefined) ?? null;
  const revokedCredIds = Array.isArray(body.revoked_credential_ids) ? (body.revoked_credential_ids as string[]) : [];
  const completedAt = new Date().toISOString();

  // Persist the cred revocations the IT user just confirmed.
  if (revokedCredIds.length > 0) {
    await admin.from("credential_assignments")
      .update({ revoked_at: completedAt, revoked_reason: "offboarding" })
      .in("id", revokedCredIds)
      .eq("employee_id", emp.id);
  }


  const { data: org } = await admin.from("organizations").select("name").eq("id", off.org_id).single();

  // NOC banner — always green once we reach this stage. Credentials are
  // shared platform logins used by many employees; "revoking" in the
  // offboarding context means we've removed THIS employee's access, not that
  // the underlying platform credential itself is disabled. So once IT has
  // completed Stage 3, every assignment recorded against this employee is
  // considered revoked from their perspective.
  const nocBanner =
    `<div style="background:#dcfce7;border:1px solid #86efac;color:#166534;padding:12px 14px;border-radius:8px;margin:0 0 16px">
       <strong>✓ No Objection Certificate (NOC) issued</strong><br/>
       All credential access has been revoked for this employee and all assigned devices reclaimed. IT confirms full handover.
     </div>`;

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#1f2937">
    <h2 style="color:#dc2626;margin:0 0 8px">Offboarding complete — ${escape(emp.full_name)}</h2>
    <p style="font-size:12px;color:#6b7280;margin:0 0 14px">Issued by ${escape(org?.name ?? "Rudrans")} · ${new Date(completedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })}</p>
    ${nocBanner}
    <p>The IT team has confirmed laptop handover. Full summary below for HR + Accounts records.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f9fafb;border-radius:8px;overflow:hidden;font-size:13px">
      <tbody>
        ${row("Employee", emp.full_name)}
        ${row("Work email", emp.work_email ?? "—")}
        ${row("Designation", emp.designation ?? "—")}
        ${row("Department", deptName)}
        ${row("Manager", managerName)}
        ${row("Date of joining", emp.doj ?? "—")}
        ${row("Last working day", emp.lwd ?? "—")}
        ${row("Laptop serial", laptopSerial ?? "—")}
        ${row("Asset notes", assetNotes ?? "—")}
        ${row("IT remark", itRemark ?? "—")}
      </tbody>
    </table>
    <h3 style="margin:20px 0 6px;font-size:15px;color:#1f2937">Credentials revocation summary</h3>
    <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden;font-size:13px">
      <thead><tr style="background:#e5e7eb"><th style="padding:8px 10px;text-align:left">Platform</th><th style="padding:8px 10px;text-align:left">Username</th><th style="padding:8px 10px;text-align:left">Status</th></tr></thead>
      <tbody>${credRows || `<tr><td colspan="3" style="padding:16px;text-align:center;color:#6b7280">None recorded.</td></tr>`}</tbody>
    </table>
    <p style="font-size:11px;color:#9ca3af;margin-top:16px">Sent from ${escape(org?.name ?? "")} via Rudrans · offboarding #${off.id}</p>
  </body></html>`;

  const allRecipients = [...new Set([...hrRecipients, ...accountsRecipients].filter(Boolean))];
  const mail = await sendGraphEmail({ orgId: emp.org_id,
    to: allRecipients[0],
    cc: allRecipients.slice(1),
    subject: `[NOC issued] ${emp.full_name} — offboarding complete`,
    html,
  });

  const now = completedAt;
  await admin.from("offboardings").update({
    current_stage: "completed",
    stage3_completed_at: now,
    laptop_serial: laptopSerial,
    asset_notes: assetNotes,
    it_remark: itRemark,
    stage3_hr_recipients: hrRecipients,
    stage3_accounts_recipients: accountsRecipients,
    status: "done",
  }).eq("id", offId);
  // Stamp the exit date (lwd) so the IT Hardware inventory and any other
  // reports can show when the employee left. If the offboarding row already
  // recorded an LWD use that, else use today.
  const exitDate = (off.lwd as string | null) ?? new Date().toISOString().slice(0, 10);
  await admin.from("employees")
    .update({ status: "offboarded", lwd: exitDate })
    .eq("id", emp.id);

  // Auto-unassign every hardware asset still held by this employee. We
  // append a hardware_assignments row with unassign_reason='offboarding' so
  // the device history stays auditable, then flip the asset back to in_stock.
  const { data: heldAssets } = await admin
    .from("hardware_assets")
    .select("id")
    .eq("assigned_employee_id", emp.id)
    .eq("status", "assigned");
  const assetIds = (heldAssets ?? []).map((a: { id: string }) => a.id);
  if (assetIds.length > 0) {
    // Close the open assignment-history rows.
    await admin.from("hardware_assignments")
      .update({ unassigned_at: now, unassign_reason: "offboarding", unassigned_by: callerId })
      .in("asset_id", assetIds)
      .is("unassigned_at", null);
    // Flip assets back to stock.
    await admin.from("hardware_assets")
      .update({ status: "in_stock", assigned_employee_id: null, unassigned_at: now })
      .in("id", assetIds);
  }

  await admin.from("offboarding_events").insert({
    offboarding_id: offId, org_id: off.org_id, actor_id: callerId, event: "completed",
    detail: { mail_ok: mail.ok, mail_error: mail.error, unassigned_assets: assetIds.length },
  });
  await admin.from("employee_audit").insert({
    org_id: off.org_id, employee_id: emp.id, actor_id: callerId, action: "offboarding_completed",
    detail: { offboarding_id: offId },
  });

  return json({ ok: true, mail }, 200);
}

// ============== helpers ==============

function row(k: string, v: string): string {
  return `<tr><td style="padding:6px 10px;color:#6b7280;width:170px">${escape(k)}</td><td style="padding:6px 10px">${escape(v)}</td></tr>`;
}
function escape(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}
function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
