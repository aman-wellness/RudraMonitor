// POST /functions/v1/asset-assign
// Headers: Authorization: Bearer <user JWT>
// Body (one of):
//   { asset_id, employee_row_id }    → assign device to user
//   { asset_id, unassign: true, reason? }  → unassign (return to stock)
//
// Bookkeeping: closes the prior open hardware_assignments row (sets
// unassigned_at) before opening a new one, so the history view stays clean.
// Directory-only target users get an employees row created on the fly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

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

  let body: { asset_id?: string; employee_row_id?: string; unassign?: boolean; reason?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const assetId = (body.asset_id ?? "").trim();
  if (!assetId) return json({ error: "asset_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: asset } = await admin.from("hardware_assets").select("*").eq("id", assetId).maybeSingle();
  if (!asset) return json({ error: "asset not found" }, 404);

  // Org membership check (caller must be in org_members of this org or its owner).
  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", callerId).eq("org_id", asset.org_id);
  const { data: ownerRow } = await admin.from("organizations").select("id").eq("id", asset.org_id).eq("owner_user_id", callerId);
  if ((mem?.length ?? 0) === 0 && (ownerRow?.length ?? 0) === 0) {
    return json({ error: "not authorised for this org" }, 403);
  }

  // ---- Close prior open assignment, if any ----
  const closePriorAssignment = async (reason: string) => {
    await admin.from("hardware_assignments")
      .update({ unassigned_at: new Date().toISOString(), unassigned_by: callerId, unassign_reason: reason })
      .eq("asset_id", assetId)
      .is("unassigned_at", null);
  };

  // ---- UNASSIGN branch ----
  if (body.unassign === true) {
    if (!asset.assigned_employee_id) return json({ ok: true, message: "asset was already in stock" }, 200);
    await closePriorAssignment(body.reason ?? "returned");
    const { error } = await admin.from("hardware_assets")
      .update({
        assigned_employee_id: null,
        unassigned_at: new Date().toISOString(),
        status: "in_stock",
      })
      .eq("id", assetId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, action: "unassigned" }, 200);
  }

  // ---- ASSIGN branch — resolve employee_row_id ----
  const rowId = (body.employee_row_id ?? "").trim();
  if (!rowId) return json({ error: "employee_row_id required" }, 400);

  let empId: string;
  if (rowId.startsWith("emp:")) {
    empId = rowId.slice(4);
    const { data: e } = await admin.from("employees").select("org_id").eq("id", empId).maybeSingle();
    if (!e || e.org_id !== asset.org_id) return json({ error: "employee not found in this org" }, 400);
  } else if (rowId.startsWith("dir:")) {
    const dirId = rowId.slice(4);
    const { data: dir } = await admin
      .from("directory_users")
      .select("org_id, provider, external_id, display_name, upn, mail, job_title")
      .eq("id", dirId).maybeSingle();
    if (!dir || dir.org_id !== asset.org_id) return json({ error: "directory user not found in this org" }, 400);
    const empCol = dir.provider === "m365" ? "m365_user_id" : "google_user_id";
    const { data: existing } = await admin.from("employees")
      .select("id").eq("org_id", asset.org_id).eq(empCol, dir.external_id).maybeSingle();
    if (existing) {
      empId = existing.id;
    } else {
      const { data: created, error: insErr } = await admin.from("employees").insert({
        org_id: asset.org_id,
        full_name: dir.display_name ?? dir.upn ?? dir.mail ?? dir.external_id,
        work_email: dir.upn ?? dir.mail ?? null,
        designation: dir.job_title ?? null,
        status: "active",
        source: "imported",
        [empCol]: dir.external_id,
        created_by: callerId,
      }).select("id").single();
      if (insErr) return json({ error: `auto-create: ${insErr.message}` }, 500);
      empId = created.id;
    }
  } else {
    return json({ error: "employee_row_id must start with 'emp:' or 'dir:'" }, 400);
  }

  // Close prior (if device was already assigned to someone else) + reassign.
  if (asset.assigned_employee_id && asset.assigned_employee_id !== empId) {
    await closePriorAssignment("reassigned");
  }

  const now = new Date().toISOString();
  const { error: upErr } = await admin.from("hardware_assets")
    .update({
      assigned_employee_id: empId,
      assigned_at: now,
      unassigned_at: null,
      status: "assigned",
    })
    .eq("id", assetId);
  if (upErr) return json({ error: upErr.message }, 500);

  await admin.from("hardware_assignments").insert({
    org_id: asset.org_id, asset_id: assetId,
    employee_id: empId, assigned_by: callerId, assigned_at: now,
  });

  return json({ ok: true, action: "assigned", employee_id: empId }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
