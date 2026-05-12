// POST /functions/v1/enroll-agent
// Body: { license_key, agent_name, machine_name, os_type }
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
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
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

  if (!license_key || !agent_name) {
    return json({ error: "license_key and agent_name are required" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id, license_key")
    .eq("license_key", license_key)
    .maybeSingle();
  if (orgErr) return json({ error: orgErr.message }, 500);
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
  if (lookupErr) return json({ error: lookupErr.message }, 500);

  if (existing) {
    await admin
      .from("agents")
      .update({ agent_name, os_type, status: "online", last_active: new Date().toISOString() })
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
      status: "online",
      last_active: new Date().toISOString(),
    })
    .select("id, enroll_token")
    .single();
  if (insertErr) return json({ error: insertErr.message }, 500);

  return json({ agent_id: created.id, enroll_token: created.enroll_token, org_id: org.id });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
