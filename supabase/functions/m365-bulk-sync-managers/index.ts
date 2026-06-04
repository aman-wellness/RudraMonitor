// POST /functions/v1/m365-bulk-sync-managers
// Headers: Authorization: Bearer <user JWT>
// Body: {} (org is inferred from caller)
//
// One-shot mirror of every portal manager_id → M365 manager/$ref for the
// caller's org. Used by the "Sync managers to M365" button in the governance
// page. Idempotent — running it again is a no-op for rows already in sync.
//
// Returns: {
//   ok, total, pushed, cleared, skipped_no_m365, skipped_manager_no_m365,
//   failed, details: [{ employee, action, status, error? }, ...]
// }

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { resolveWriterOrgId } from "../_shared/auth-org.ts";
import { graphTokenFor } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const orgId = await resolveWriterOrgId(admin, u.user.id);
  if (!orgId) return json({ error: "not authorised (owner/admin required)" }, 403);

  // Fetch all active employees in the org that are linked to M365.
  const { data: empsRaw, error: empsErr } = await admin
    .from("employees")
    .select("id, full_name, manager_id, m365_user_id, status")
    .eq("org_id", orgId)
    .not("status", "in", "(\"offboarding\",\"offboarded\",\"disabled\",\"terminated\",\"inactive\",\"suspended\")");
  if (empsErr) return json({ error: empsErr.message }, 500);
  type Emp = { id: string; full_name: string; manager_id: string | null; m365_user_id: string | null; status: string | null };
  const emps = (empsRaw as Emp[] | null) ?? [];
  const byId = new Map(emps.map((e) => [e.id, e]));

  // Mint one Graph token for the entire batch.
  let accessToken: string;
  try {
    const t = await graphTokenFor(orgId);
    accessToken = t.accessToken;
  } catch (e) {
    return json({ error: `Graph token error: ${(e as Error).message}` }, 502);
  }

  const details: Array<{ employee: string; action: string; status: number | string; error?: string }> = [];
  let pushed = 0, cleared = 0, skipNoM365 = 0, skipMgrNoM365 = 0, failed = 0;

  for (const e of emps) {
    if (!e.m365_user_id) { skipNoM365++; continue; }

    if (!e.manager_id) {
      // Portal says no manager — clear in M365 too (DELETE is idempotent;
      // 404 means already cleared).
      try {
        const r = await fetch(`${GRAPH_BASE}/users/${e.m365_user_id}/manager/$ref`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (r.ok || r.status === 404) {
          cleared++;
          details.push({ employee: e.full_name, action: "clear", status: r.status });
        } else {
          failed++;
          details.push({ employee: e.full_name, action: "clear", status: r.status, error: (await r.text()).slice(0, 200) });
        }
      } catch (err) {
        failed++;
        details.push({ employee: e.full_name, action: "clear", status: "network", error: (err as Error).message });
      }
      continue;
    }

    const mgr = byId.get(e.manager_id);
    if (!mgr?.m365_user_id) {
      skipMgrNoM365++;
      details.push({ employee: e.full_name, action: "skip", status: "manager-not-linked", error: `Manager "${mgr?.full_name ?? "(unknown)"}" has no M365 link` });
      continue;
    }

    try {
      const r = await fetch(`${GRAPH_BASE}/users/${e.m365_user_id}/manager/$ref`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ "@odata.id": `${GRAPH_BASE}/users/${mgr.m365_user_id}` }),
      });
      if (r.ok) {
        pushed++;
        details.push({ employee: e.full_name, action: `set → ${mgr.full_name}`, status: r.status });
      } else {
        failed++;
        details.push({ employee: e.full_name, action: `set → ${mgr.full_name}`, status: r.status, error: (await r.text()).slice(0, 200) });
      }
    } catch (err) {
      failed++;
      details.push({ employee: e.full_name, action: `set → ${mgr.full_name}`, status: "network", error: (err as Error).message });
    }
  }

  // Audit log (best effort).
  try {
    await admin.from("gov_audit_events").insert({
      org_id: orgId,
      actor_id: u.user.id,
      entity_type: "m365",
      entity_id: orgId,
      action: "bulk_sync_managers",
      detail: { total: emps.length, pushed, cleared, skipNoM365, skipMgrNoM365, failed },
    });
  } catch { /* table may not exist yet; ignore */ }

  return json({
    ok: true,
    total: emps.length,
    pushed,
    cleared,
    skipped_no_m365: skipNoM365,
    skipped_manager_no_m365: skipMgrNoM365,
    failed,
    details,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
