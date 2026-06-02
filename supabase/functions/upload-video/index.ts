// POST /functions/v1/upload-video
// Headers: Authorization: Bearer <enroll_token>  (or X-Agent-Token)
// Body: { video_b64: string, taken_at: string (RFC3339), duration_secs?: number }
//
// Upload path: videos/<org_id>/<agent_id>/<unix_ts>.mp4
// Inserts an activity_logs row with activity_type='video', video_url=<path>.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_BYTES = 16 * 1024 * 1024; // matches bucket file_size_limit

type Body = {
  video_b64?: string;
  taken_at?: string;
  duration_secs?: number;
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
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.video_b64 || !body.taken_at) {
    return json({ error: "video_b64 and taken_at are required" }, 400);
  }

  let bytes: Uint8Array;
  try {
    const bin = atob(body.video_b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return json({ error: "invalid base64" }, 400);
  }
  if (bytes.byteLength > MAX_BYTES) return json({ error: "video too large" }, 413);

  // MP4 container magic-byte check. The file MUST begin with an ISO Base
  // Media File Format box header — bytes 4–7 are 'ftyp' ('f','t','y','p').
  // We accept any brand at offset 8+ (mp42, isom, M4V, etc.). Without this
  // guard, an agent compromise could upload arbitrary blobs (scripts, ZIPs)
  // that downstream playback or AV scanning would treat as video.
  if (bytes.byteLength < 12 ||
      bytes[4] !== 0x66 || bytes[5] !== 0x74 ||
      bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    return json({ error: "not a valid MP4 (missing ftyp box)" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: agent, error: agentErr } = await admin
    .from("agents")
    .select("id, org_id, videos_enabled")
    .eq("enroll_token", token)
    .maybeSingle();
  if (agentErr) return json({ error: agentErr.message }, 500);
  if (!agent) return json({ error: "invalid token" }, 401);

  // Seat enforcement (migration 0078): refuse uploads from over-cap agents.
  const { data: seatOk } = await admin.rpc("agent_seat_ok", { p_agent_id: agent.id });
  if (!seatOk) return json({ error: "seat_limit_exceeded" }, 402);

  // Server-side gate — see upload-screenshot for the rationale. Honour the
  // dashboard toggle the moment it flips rather than waiting for the agent
  // to refresh its cached settings.
  if (!agent.videos_enabled) {
    return json({ error: "videos disabled for this agent", code: "captures_disabled" }, 403);
  }

  const ts = Math.floor(new Date(body.taken_at).getTime() || Date.now());
  const path = `${agent.org_id}/${agent.id}/${ts}.mp4`;

  const { error: uploadErr } = await admin.storage
    .from("videos")
    .upload(path, bytes, { contentType: "video/mp4", upsert: false });
  if (uploadErr) return json({ error: `upload: ${uploadErr.message}` }, 500);

  const { error: insertErr } = await admin.from("activity_logs").insert({
    agent_id: agent.id,
    activity_type: "video",
    application_name: null,
    url: null,
    duration: body.duration_secs ?? null,
    video_url: path,
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
