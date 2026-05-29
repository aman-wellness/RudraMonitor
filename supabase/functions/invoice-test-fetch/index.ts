// POST /functions/v1/invoice-test-fetch
// Headers: Authorization: Bearer <user JWT>
// Body:    { credential_id: string, tier?: 'api' | 'scrape' }
//
// One-shot manual enqueue from the vault UI. Lets the admin click
// "Test fetch" without waiting for the daily cron. We just create a job
// row pointing at the current billing period for this credential; the
// dispatcher / worker takes over from there.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  let body: { credential_id?: string; tier?: "api" | "scrape" };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const credId = (body.credential_id ?? "").trim();
  if (!credId) return json({ error: "credential_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  const { data: cred } = await admin
    .from("credentials")
    .select("id, org_id, billing_api_provider, billing_cycle, subscription_starts_at")
    .eq("id", credId)
    .maybeSingle();
  if (!cred) return json({ error: "credential not found" }, 404);

  const { data: mem } = await admin.from("org_members")
    .select("org_id").eq("user_id", u.user.id).eq("org_id", cred.org_id);
  if (!mem?.length) return json({ error: "not authorised for this org" }, 403);

  // Compute period via the SQL helper.
  const { data: periodRows, error: pErr } = await admin.rpc("invoice_period_for", {
    p_starts_at: cred.subscription_starts_at,
    p_cycle: cred.billing_cycle,
    p_now: new Date().toISOString(),
  });
  if (pErr) return json({ error: `period: ${pErr.message}` }, 500);
  const p = Array.isArray(periodRows) ? periodRows[0] : periodRows;
  if (!p) return json({ error: "could not compute billing period — set Starts on" }, 400);

  const tier = body.tier ?? (cred.billing_api_provider ? "api" : "scrape");

  // Insert (or noop on conflict). Returns id either way.
  const { data: existing } = await admin
    .from("invoice_fetch_jobs")
    .select("id, status")
    .eq("credential_id", credId)
    .eq("billing_period_start", p.period_start)
    .in("status", ["queued", "running", "needs_otp"])
    .maybeSingle();
  if (existing) {
    return json({ ok: true, job_id: existing.id, status: existing.status, note: "already open" }, 200);
  }

  const { data: ins, error: iErr } = await admin
    .from("invoice_fetch_jobs")
    .insert({
      org_id: cred.org_id,
      credential_id: credId,
      billing_period_start: p.period_start,
      billing_period_end: p.period_end,
      tier,
      status: "queued",
    })
    .select("id")
    .single();
  if (iErr || !ins) return json({ error: `insert: ${iErr?.message}` }, 500);

  // Kick the dispatcher immediately so the test result feels instant.
  fetch(`${SUPABASE_URL}/functions/v1/invoice-fetch-dispatch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ triggered_by: "test-fetch" }),
  }).catch(() => null);

  return json({ ok: true, job_id: ins.id, tier, period_start: p.period_start, period_end: p.period_end }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
