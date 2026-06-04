// POST /functions/v1/m365-verify-manager
// Headers: Authorization: Bearer <user JWT>
// Body: { employee_id }
//
// Diagnostic endpoint. Calls Graph API directly and returns what M365
// CURRENTLY thinks the manager is for an employee — bypassing all admin-
// portal caches. Useful when the customer sees "No manager" in the M365
// admin portal and isn't sure whether it's a stale view or a real sync
// failure.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
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

  let body: { employee_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const empId = (body.employee_id ?? "").trim();
  if (!empId) return json({ error: "employee_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: emp } = await admin.from("employees")
    .select("org_id, full_name, m365_user_id")
    .eq("id", empId).maybeSingle();
  if (!emp) return json({ error: "employee not found" }, 404);
  const e = emp as { org_id: string; full_name: string; m365_user_id: string | null };
  if (!e.m365_user_id) return json({ error: "employee has no m365_user_id (not linked to M365)" }, 400);

  const { accessToken } = await graphTokenFor(e.org_id);
  const url = `${GRAPH_BASE}/users/${e.m365_user_id}/manager`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const status = r.status;
  const responseText = await r.text();
  let mgrPayload: unknown = null;
  try { mgrPayload = JSON.parse(responseText); } catch { mgrPayload = responseText; }

  return json({
    ok: true,
    employee: { id: empId, name: e.full_name, m365_user_id: e.m365_user_id },
    graph_status: status,
    graph_url: url,
    graph_response: mgrPayload,
    interpretation: status === 200
      ? "M365 confirms the manager is set (see graph_response.displayName)"
      : status === 404
      ? "M365 says no manager is set (or user not found)"
      : `Unexpected ${status}`,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
