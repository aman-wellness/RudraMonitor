// POST /functions/v1/validate-license
// Body: { license_key: string, org_id?: string }
// Public function (no auth required) — called by the desktop agent on heartbeat.
//
// Returns: { valid: boolean, status, expires_at, organization_id, plan_code, seat_count, reason? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// SECURITY REVIEW (Low): light anti-enumeration limiter. This endpoint is
// public and reveals org metadata for a VALID key, so an attacker could probe
// many keys. We rate-limit ONLY failed lookups per IP — a legitimate agent
// always sends its real key, so it never accumulates failures. Crucially this
// means an office NAT'ing dozens of agents behind one IP is NOT throttled
// (their heartbeats succeed); only an IP spraying invalid keys gets blocked.
// Best-effort/in-memory (per isolate) — a speed bump, not a wall.
const FAILS = new Map<string, { n: number; resetAt: number }>();
const FAIL_WINDOW_MS = 60_000;
const FAIL_MAX = 20;
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return (xff.split(",")[0] ?? "").trim() || "unknown";
}
function isBlocked(ip: string): boolean {
  const e = FAILS.get(ip);
  return !!e && Date.now() <= e.resetAt && e.n > FAIL_MAX;
}
function noteFailure(ip: string): void {
  const now = Date.now();
  const e = FAILS.get(ip);
  if (!e || now > e.resetAt) FAILS.set(ip, { n: 1, resetAt: now + FAIL_WINDOW_MS });
  else e.n++;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ valid: false, reason: "method not allowed" }, 405);

  const ip = clientIp(req);
  if (isBlocked(ip)) return json({ valid: false, reason: "rate limited — too many invalid keys" }, 429);

  let body: { license_key?: string; org_id?: string; agent_id?: string };
  try { body = await req.json(); } catch { return json({ valid: false, reason: "invalid json" }, 400); }
  const key = (body.license_key ?? "").trim();
  if (!key) return json({ valid: false, reason: "license_key required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The license key lives in two places due to legacy schema decisions:
  // organizations.license_key (what the dashboard surfaces and the customer
  // copies) and licenses.license_key (the row that drives status / seats /
  // expiry). Older builds let these drift, so the agent could enroll fine via
  // enroll-agent (which reads organizations) and then fail validate-license
  // (which read only licenses) with a confusing "license not found".
  //
  // Look up by either column and resolve to the canonical licenses row.
  let { data: lic, error } = await admin
    .from("licenses")
    .select("id, status, expires_at, organization_id, seat_count, plan_id, plans(code)")
    .eq("license_key", key)
    .maybeSingle();

  if (error) return json({ valid: false, reason: error.message }, 500);

  if (!lic) {
    const { data: org } = await admin
      .from("organizations")
      .select("id")
      .eq("license_key", key)
      .maybeSingle();
    if (org) {
      const { data: licByOrg } = await admin
        .from("licenses")
        .select("id, status, expires_at, organization_id, seat_count, plan_id, plans(code)")
        .eq("organization_id", org.id)
        .order("issued_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      lic = licByOrg ?? null;
    }
  }

  if (!lic) { noteFailure(ip); return json({ valid: false, reason: "license not found" }); }

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

  // Seat enforcement: how many agents this org has + (if the caller
  // identified its own agent via body.agent_id) whether THAT agent is
  // within the cap. Previously we marked the whole license invalid when
  // over-seated, locking every agent — including the legitimate ones.
  // Now: the org is "valid", but each agent is told its own status via
  // agent_seat_ok().
  const orgId = lic.organization_id as string;
  const { count: seatsUsed } = await admin
    .from("agents")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);

  let seat_ok = true;
  if (body.agent_id) {
    const { data: ok } = await admin.rpc("agent_seat_ok", { p_agent_id: body.agent_id });
    seat_ok = !!ok;
  }

  return json({
    valid: seat_ok,
    status: lic.status,
    expires_at: lic.expires_at,
    organization_id: orgId,
    seat_count: lic.seat_count,
    seats_used: seatsUsed ?? 0,
    plan_code: (lic.plans as { code?: string } | null)?.code ?? null,
    reason: seat_ok ? undefined : "seat_limit_exceeded",
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
