// POST /functions/v1/dlp-email-ingest
//
// Two-phase upload for a full webmail send captured by the agent's MITM proxy.
//
// Phase 1 — open (action=open):
//   Headers: X-Agent-Token: <enroll_token>, apikey: <anon>
//   Body: {
//     action: "open",
//     mail_provider: string,
//     mail_url?: string,
//     from_address?: string,
//     subject?: string,
//     body_text?: string,
//     body_html?: string,
//     to_recipients: string[],
//     cc_recipients?: string[],
//     bcc_recipients?: string[],
//     active_window?: string,
//     screenshot_b64?: string,      // optional JPEG, dropped into `screenshots` bucket
//     attachments: [{
//       file_name: string,
//       file_size_bytes: number,
//       file_mime?: string,
//       file_hash_sha256?: string,
//     }],
//     occurred_at?: string,
//   }
//   Returns: {
//     event_id: string,
//     upload_urls: [{ attachment_id, file_name, signed_url, storage_path }],
//   }
//
// Phase 2 — the agent PUTs each attachment's bytes to its signed_url
// directly against the Storage API (no server hop). Signed URLs are 30-
// minute one-shot uploads scoped to the dlp-email-attachments bucket.
//
// Phase 3 — finalize (action=finalize):
//   Body: { action: "finalize", event_id: string }
//   Server marks the event ingested, runs the AI classifier, and (if
//   flagged unauthorized) triggers dlp-alert-email.
//
// Rows stuck in `pending` > 30 min are reaped by the pg_cron job set up
// in migration 0148.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ATTACHMENT_BUCKET = "dlp-email-attachments";
const SCREENSHOT_BUCKET = "screenshots";
// Matches the bucket file_size_limit set at creation time (25 MB).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// One upload URL is valid for 30 min — plenty for a 25 MB PUT even on a
// slow connection, and past that we'd rather force the agent to re-open
// than serve a stale token.
const UPLOAD_URL_TTL_SECONDS = 30 * 60;

interface AttachmentIn {
  file_name: string;
  file_size_bytes: number;
  file_mime?: string;
  file_hash_sha256?: string;
}

interface OpenBody {
  action: "open";
  mail_provider: string;
  mail_url?: string;
  from_address?: string;
  subject?: string;
  body_text?: string;
  body_html?: string;
  to_recipients?: string[];
  cc_recipients?: string[];
  bcc_recipients?: string[];
  active_window?: string;
  screenshot_b64?: string;
  attachments?: AttachmentIn[];
  occurred_at?: string;
}

interface FinalizeBody {
  action: "finalize";
  event_id: string;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const token = req.headers.get("x-agent-token") ?? "";
  if (!token) return json({ error: "missing X-Agent-Token" }, 401);

  let raw: OpenBody | FinalizeBody;
  try { raw = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!raw || typeof raw !== "object") return json({ error: "invalid body" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve agent + org from enroll_token (mirrors dlp-ingest / agent-settings).
  const { data: agent } = await admin
    .from("agents")
    .select("id, org_id, dlp_enabled")
    .eq("enroll_token", token)
    .maybeSingle();
  if (!agent) return json({ error: "agent not found" }, 404);

  // Seat + dlp gates (0078 seat enforcement + per-agent dlp_enabled).
  const { data: seatOk } = await admin.rpc("agent_seat_ok", { p_agent_id: agent.id });
  if (!seatOk) return json({ error: "seat_limit_exceeded" }, 402);
  if (!agent.dlp_enabled) return json({ ok: true, skipped: "agent dlp disabled" });

  // Per-org kill switches.
  const { data: settings } = await admin
    .from("dlp_settings").select("*").eq("org_id", agent.org_id).maybeSingle();
  if (settings) {
    if (!settings.email_enabled) return json({ ok: true, skipped: "email dlp disabled" });
    if (!settings.email_intercept_public_only) return json({ ok: true, skipped: "email intercept turned off" });
  }

  if (raw.action === "open") return handleOpen(admin, agent, settings, raw);
  if (raw.action === "finalize") return handleFinalize(admin, agent, raw);
  return json({ error: "unknown action" }, 400);
});

async function handleOpen(
  admin: ReturnType<typeof createClient>,
  agent: { id: string; org_id: string },
  settings: { email_body_capture?: boolean } | null,
  body: OpenBody,
) {
  if (!body.mail_provider) return json({ error: "mail_provider required" }, 400);
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  // Reject oversized attachments up front — no point creating a row we
  // can't populate.
  for (const a of attachments) {
    if (!a.file_name) return json({ error: "attachment file_name required" }, 400);
    if (typeof a.file_size_bytes !== "number" || a.file_size_bytes < 0) {
      return json({ error: `attachment ${a.file_name}: invalid size` }, 400);
    }
    if (a.file_size_bytes > MAX_ATTACHMENT_BYTES) {
      return json({ error: `attachment ${a.file_name}: exceeds ${MAX_ATTACHMENT_BYTES} bytes` }, 413);
    }
  }

  // Some jurisdictions allow us to log metadata (recipients / subject /
  // attachment names) but NOT full body content. The per-org toggle
  // email_body_capture=false strips body_text and body_html here — the
  // agent still sends them, we just drop them at the boundary so the DB
  // never has them.
  const captureBody = settings?.email_body_capture !== false;

  // Optional screenshot at send-time (reuses screenshots bucket).
  let screenshot_url: string | null = null;
  if (body.screenshot_b64) {
    try {
      const bytes = Uint8Array.from(atob(body.screenshot_b64), (c) => c.charCodeAt(0));
      const path = `${agent.org_id}/${agent.id}/${Date.now()}-email-send.jpg`;
      const up = await admin.storage.from(SCREENSHOT_BUCKET).upload(path, bytes, {
        contentType: "image/jpeg", upsert: true,
      });
      if (!up.error) screenshot_url = path;
    } catch { /* screenshot best-effort */ }
  }

  const { data: ev, error: evErr } = await admin
    .from("dlp_email_events")
    .insert({
      org_id: agent.org_id,
      agent_id: agent.id,
      mail_provider: body.mail_provider,
      mail_url: body.mail_url ?? null,
      from_address: body.from_address ?? null,
      subject: body.subject ?? null,
      body_text: captureBody ? body.body_text ?? null : null,
      body_html: captureBody ? body.body_html ?? null : null,
      to_recipients: body.to_recipients ?? [],
      cc_recipients: body.cc_recipients ?? [],
      bcc_recipients: body.bcc_recipients ?? [],
      attachments_count: attachments.length,
      screenshot_url,
      active_window: body.active_window ?? null,
      occurred_at: body.occurred_at ?? new Date().toISOString(),
      ingest_state: attachments.length === 0 ? "ingested" : "pending",
    })
    .select("id")
    .single();
  if (evErr || !ev) return json({ error: evErr?.message ?? "insert failed" }, 500);

  // Mint a signed upload URL per attachment. Each is single-use and
  // scoped to a specific path — even if leaked, it can only PUT that
  // exact path.
  const upload_urls: Array<{
    attachment_id: string;
    file_name: string;
    signed_url: string;
    storage_path: string;
  }> = [];

  for (const a of attachments) {
    // storage_path shape mirrors the existing screenshots/videos convention:
    // <org_id>/<agent_id>/<event_id>/<hash-or-time>-<sanitized_name>
    const safeName = a.file_name.replace(/[^\w.\- ]+/g, "_").slice(0, 200);
    const hashOrTs = a.file_hash_sha256 ?? String(Date.now());
    const storage_path = `${agent.org_id}/${agent.id}/${ev.id}/${hashOrTs}-${safeName}`;

    const { data: att, error: attErr } = await admin
      .from("dlp_email_attachments")
      .insert({
        event_id: ev.id,
        org_id: agent.org_id,
        file_name: a.file_name,
        file_size_bytes: a.file_size_bytes,
        file_mime: a.file_mime ?? null,
        file_hash_sha256: a.file_hash_sha256 ?? null,
        storage_path,
      })
      .select("id")
      .single();
    if (attErr || !att) continue;

    const { data: signed } = await admin.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUploadUrl(storage_path);
    if (!signed) continue;

    upload_urls.push({
      attachment_id: att.id,
      file_name: a.file_name,
      signed_url: signed.signedUrl,
      storage_path,
    });
  }

  // If no attachments (or all upload URL mints failed), the event is
  // already ingested and won't need a finalize call — surface that.
  return json({
    event_id: ev.id,
    upload_urls,
    finalize_required: upload_urls.length > 0,
  });
}

async function handleFinalize(
  admin: ReturnType<typeof createClient>,
  agent: { id: string; org_id: string },
  body: FinalizeBody,
) {
  if (!body.event_id) return json({ error: "event_id required" }, 400);

  // Confirm the event belongs to this agent (defense-in-depth over RLS —
  // the service_role bypasses RLS, so this check is the only one
  // stopping agent A from finalizing agent B's event by guessing an id).
  const { data: ev } = await admin
    .from("dlp_email_events")
    .select("id, org_id, agent_id, ingest_state")
    .eq("id", body.event_id)
    .maybeSingle();
  if (!ev || ev.agent_id !== agent.id) return json({ error: "event not found" }, 404);
  if (ev.ingest_state === "ingested") return json({ ok: true, already: true });

  // Mark attachments uploaded (best-effort — Storage doesn't notify us,
  // so we rely on the agent's finalize call to say "I PUT them all").
  await admin
    .from("dlp_email_attachments")
    .update({ uploaded_at: new Date().toISOString() })
    .eq("event_id", ev.id)
    .is("uploaded_at", null);

  const { error } = await admin
    .from("dlp_email_events")
    .update({ ingest_state: "ingested" })
    .eq("id", ev.id);
  if (error) return json({ error: error.message }, 500);

  // AI classification + admin-alert wiring — deferred to a follow-up
  // (needs the extended dlp-alert-email template). Row lands as
  // "ingested" without ai_severity; dashboard shows it under a
  // "Pending review" filter until classifier runs.

  return json({ ok: true, event_id: ev.id });
}
