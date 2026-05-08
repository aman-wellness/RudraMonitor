// POST /functions/v1/validate-license
// Body: { license_key: string, org_id?: string }
// Public function (no auth required) — called by the desktop agent on heartbeat.
//
// Returns: { valid: boolean, status, expires_at, organization_id, plan_code, seat_count, reason? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ valid: false, reason: "method not allowed" }, 405);

  let body: { license_key?: string; org_id?: string };
  try { body = await req.json(); } catch { return json({ valid: false, reason: "invalid json" }, 400); }
  const key = (body.license_key ?? "").trim();
  if (!key) return json({ valid: false, reason: "license_key required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: lic, error } = await admin
    .from("licenses")
    .select("id, status, expires_at, organization_id, seat_count, plan_id, plans(code)")
    .eq("license_key", key)
    .maybeSingle();

  if (error) return json({ valid: false, reason: error.message }, 500);
  if (!lic) return json({ valid: false, reason: "license not found" });

  if (body.org_id && lic.organization_id !== body.org_id) {
    return json({ valid: false, reason: "license belongs to a different organization" });
  }

  const now = new Date();
  const expired = new Date(lic.expires_at as string) < now;

  if (lic.status !== "active") {
    return json({
      valid: false,
      reason: `license ${lic.status}`,
      status: lic.status,
      expires_at: lic.expires_at,
      organization_id: lic.organization_id,
    });
  }
  if (expired) {
    // Auto-mark expired so the dashboard reflects reality
    await admin.from("licenses").update({ status: "expired" }).eq("id", lic.id);
    return json({
      valid: false,
      reason: "license expired",
      status: "expired",
      expires_at: lic.expires_at,
      organization_id: lic.organization_id,
    });
  }

  // Seat enforcement: how many agents this org has
  const { count: seatsUsed } = await admin
    .from("agents")
    .select("id", { count: "exact", head: true })
    .eq("org_id", lic.organization_id);

  const overSeated = (seatsUsed ?? 0) > Number(lic.seat_count ?? 0);

  return json({
    valid: !overSeated,
    status: lic.status,
    expires_at: lic.expires_at,
    organization_id: lic.organization_id,
    seat_count: lic.seat_count,
    seats_used: seatsUsed ?? 0,
    plan_code: (lic.plans as { code?: string } | null)?.code ?? null,
    reason: overSeated ? "seat limit exceeded" : undefined,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
