// POST /functions/v1/enroll-agent
// Body: { license_key, agent_name, machine_name, os_type, agent_version }
// Auth: Supabase project anon key (Authorization: Bearer ANON_KEY) — required by the gateway.
//
// Behaviour:
//   1. Look up the organization whose license_key matches.
//   2. If an agent row already exists for (org_id, machine_name) reuse it; otherwise create one.
//   3. Return { agent_id, enroll_token, org_id }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type EnrollBody = {
  license_key?: string;
  agent_name?: string;
  machine_name?: string;
  os_type?: string;
  agent_version?: string;
};

// Per-IP rate limiter for license-key lookups. Without this an attacker
// can blast the endpoint guessing keys. Limit: 10 attempts per 10 minutes
// per IP. State is in-process so it resets on cold-start — acceptable for
// the threat model (attacker would need to spin up many functions in
// parallel to bypass, which is loud enough to detect).
const ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 10;

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ATTEMPTS.get(ip);
  if (!entry || entry.resetAt < now) {
    ATTEMPTS.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count += 1;
  return true;
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return (xff.split(",")[0] || "").trim() || "unknown";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const ip = clientIp(req);
  if (!rateLimit(ip)) {
    return json({ error: "too many attempts, slow down" }, 429);
  }

  let body: EnrollBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const license_key = (body.license_key ?? "").trim();
  const agent_name = (body.agent_name ?? "").trim();
  const machine_name = (body.machine_name ?? "").trim() || agent_name;
  const os_type = (body.os_type ?? "").trim() || null;
  const agent_version = (body.agent_version ?? "").trim() || null;

  if (!license_key || !agent_name) {
    return json({ error: "license_key and agent_name are required" }, 400);
  }
  // Bound input sizes to prevent DoS via giant strings.
  if (license_key.length > 128 || agent_name.length > 256
      || machine_name.length > 256
      || (os_type && os_type.length > 64)
      || (agent_version && agent_version.length > 64)) {
    return json({ error: "input too long" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id, license_key")
    .eq("license_key", license_key)
    .maybeSingle();
  if (orgErr) {
    console.error("enroll-agent org lookup:", orgErr);
    return json({ error: "internal error" }, 500);
  }
  if (!org) return json({ error: "invalid license key" }, 404);

  // Block fresh enrollments once subscription is dead. is_subscription_active
  // covers expired trials, cancelled orgs, and orgs with no active license.
  const { data: active } = await admin.rpc("is_subscription_active", { p_org_id: org.id });
  if (!active) {
    return json({ error: "subscription inactive — trial expired or unpaid" }, 402);
  }

  // Reuse existing row for this machine (idempotent enrollment).
  const { data: existing, error: lookupErr } = await admin
    .from("agents")
    .select("id, enroll_token")
    .eq("org_id", org.id)
    .eq("machine_name", machine_name)
    .maybeSingle();
  if (lookupErr) {
    console.error("enroll-agent existing lookup:", lookupErr);
    return json({ error: "internal error" }, 500);
  }

  if (existing) {
    await admin
      .from("agents")
      .update({ agent_name, os_type, agent_version, status: "online", last_active: new Date().toISOString() })
      .eq("id", existing.id);
    return json({ agent_id: existing.id, enroll_token: existing.enroll_token, org_id: org.id });
  }

  const { data: created, error: insertErr } = await admin
    .from("agents")
    .insert({
      org_id: org.id,
      agent_name,
      machine_name,
      os_type,
      agent_version,
      status: "online",
      last_active: new Date().toISOString(),
    })
    .select("id, enroll_token")
    .single();
  if (insertErr) {
    console.error("enroll-agent insert:", insertErr);
    return json({ error: "internal error" }, 500);
  }

  return json({ agent_id: created.id, enroll_token: created.enroll_token, org_id: org.id });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
