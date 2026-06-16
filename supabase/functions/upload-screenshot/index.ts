// POST /functions/v1/upload-screenshot
// Headers: Authorization: Bearer <enroll_token>  (or X-Agent-Token)
// Body: { image_b64: string, taken_at: string (RFC3339), reason?: string }
//
// Steps:
//   1. Validate the agent token → resolve agent_id + org_id.
//   2. Decode base64, upload to bucket "screenshots" at path <org_id>/<agent_id>/<ts>.jpg.
//   3. Insert an activity_logs row with activity_type='screenshot', screenshot_url=<path>.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_BYTES = 5 * 1024 * 1024; // matches bucket file_size_limit (5 MB — Retina-Mac screenshots can be ~1-2 MB even after sips downscale)

type Body = {
  image_b64?: string;
  taken_at?: string;
  reason?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";
  const token = xAgent || bearer;
  if (!token) return json({ error: "missing agent token" }, 401);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body.image_b64 || !body.taken_at) {
    return json({ error: "image_b64 and taken_at are required" }, 400);
  }

  let bytes: Uint8Array;
  try {
    const bin = atob(body.image_b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return json({ error: "invalid base64" }, 400);
  }
  if (bytes.byteLength > MAX_BYTES) {
    return json({ error: "image too large" }, 413);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: agent, error: agentErr } = await admin
    .from("agents")
    .select("id, org_id, screenshots_enabled")
    .eq("enroll_token", token)
    .maybeSingle();
  if (agentErr) return json({ error: agentErr.message }, 500);
  if (!agent) return json({ error: "invalid token" }, 401);

  // Seat enforcement (migration 0078): refuse uploads from over-cap agents.
  const { data: seatOk } = await admin.rpc("agent_seat_ok", { p_agent_id: agent.id });
  if (!seatOk) return json({ error: "seat_limit_exceeded" }, 402);

  // Server-side gate. The agent already checks its cached flag, but that cache
  // can lag the dashboard by up to a minute, and older builds / a leaked token
  // could bypass the client-side check entirely. Reject here so the toggle is
  // honoured the instant it flips, not on the next agent settings refresh.
  if (!agent.screenshots_enabled) {
    return json({ error: "screenshots disabled for this agent", code: "captures_disabled" }, 403);
  }

  const ts = Math.floor(new Date(body.taken_at).getTime() || Date.now());
  const path = `${agent.org_id}/${agent.id}/${ts}.jpg`;

  const { error: uploadErr } = await admin.storage
    .from("screenshots")
    .upload(path, bytes, { contentType: "image/jpeg", upsert: false });
  if (uploadErr) return json({ error: `upload: ${uploadErr.message}` }, 500);

  const { error: insertErr } = await admin.from("activity_logs").insert({
    agent_id: agent.id,
    activity_type: "screenshot",
    application_name: null,
    url: body.reason ?? null,
    duration: null,
    screenshot_url: path,
    created_at: body.taken_at,
  });
  if (insertErr) return json({ error: `insert: ${insertErr.message}` }, 500);

  await admin
    .from("agents")
    .update({ last_active: new Date().toISOString(), status: "online" })
    .eq("id", agent.id);

  return json({ ok: true, path });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
