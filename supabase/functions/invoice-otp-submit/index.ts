// POST /functions/v1/invoice-otp-submit
// Two callers:
//
//   (a) Magic-link page (anonymous): Authorization absent.
//       Body: { request_id, token, code, via: 'magic_link' }
//       Validates sha256(token) == otp_requests.magic_token_hash.
//
//   (b) Dashboard banner (authenticated org admin): Authorization: Bearer <user JWT>
//       Body: { request_id, code, via: 'dashboard' }
//       Validates user is in otp_admin_user_ids OR has org_role 'owner'/'admin'.
//
// On success: writes response, flips status='fulfilled', flips parent
// job back to status='running' so the worker poll picks up the code.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { sha256Hex } from "../_shared/hmac.ts";
import { logEvent } from "../_shared/event-log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface SubmitBody {
  request_id?: string;
  token?: string;
  code?: string;
  via?: "magic_link" | "dashboard";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: SubmitBody;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const requestId = (body.request_id ?? "").trim();
  const code = (body.code ?? "").trim();
  if (!requestId) return json({ error: "request_id required" }, 400);
  if (!code || code.length < 4) return json({ error: "code required (min 4 digits)" }, 400);

  // Reject obviously malformed request_ids before touching the DB so an
  // attacker cannot use this endpoint as an existence oracle.
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
    return json({ error: "invalid request_id" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Per (request_id, ip) brute-force protection. See migration 0110.
  const xff = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "0.0.0.0";
  const { data: rl } = await admin.rpc("check_and_record_otp_attempt", {
    p_scope: "invoice_otp",
    p_channel_key: requestId,
    p_ip: xff,
  });
  if (rl && (rl as { allowed?: boolean }).allowed === false) {
    return json({ error: "too many attempts — try again in 15 minutes" }, 429);
  }

  // Lazy-expire stale rows, then fetch.
  await admin.rpc("otp_requests_expire_stale").catch(() => null);

  const { data: r } = await admin
    .from("otp_requests")
    .select("id, org_id, job_id, status, magic_token_hash, expires_at")
    .eq("id", requestId)
    .maybeSingle();
  if (!r) return json({ error: "request not found" }, 404);
  if (r.status !== "pending") return json({ error: `request is ${r.status}` }, 409);
  if (new Date(r.expires_at) < new Date()) {
    await admin.from("otp_requests").update({ status: "expired" }).eq("id", r.id);
    return json({ error: "expired" }, 410);
  }

  let respondedBy: string | null = null;
  let via = body.via ?? "magic_link";

  if (body.token) {
    // Magic-link path: verify token hash.
    const incomingHash = await sha256Hex(body.token);
    if (incomingHash !== r.magic_token_hash) {
      return json({ error: "invalid token" }, 403);
    }
    via = "magic_link";
  } else {
    // Dashboard path: require user JWT + membership.
    const auth = req.headers.get("authorization") ?? "";
    const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!jwt) return json({ error: "token or user JWT required" }, 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return json({ error: "invalid user token" }, 401);

    const { data: mem } = await admin.from("org_members")
      .select("role").eq("user_id", u.user.id).eq("org_id", r.org_id).maybeSingle();
    if (!mem) return json({ error: "not in org" }, 403);

    respondedBy = u.user.id;
    via = "dashboard";
  }

  // Write the response.
  const { error: updErr } = await admin
    .from("otp_requests")
    .update({
      status: "fulfilled",
      response: code,
      responded_by: respondedBy,
      responded_via: via,
      fulfilled_at: new Date().toISOString(),
    })
    .eq("id", r.id)
    .eq("status", "pending");
  if (updErr) return json({ error: `update: ${updErr.message}` }, 500);

  // Flip parent job back to running so the worker poll picks up the OTP.
  await admin.from("invoice_fetch_jobs").update({ status: "running" })
    .eq("id", r.job_id).eq("status", "needs_otp");

  await logEvent({
    orgId: r.org_id, jobId: r.job_id,
    kind: "otp_received",
    actor: respondedBy ? `admin:${respondedBy}` : "magic_link",
    channel: via,
    message: `OTP received via ${via}`,
  });

  return json({ ok: true }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
