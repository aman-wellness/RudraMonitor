// POST /functions/v1/dlp-ingest
// Headers: X-Agent-Token: <enroll_token>   apikey: <anon>
// Body: {
//   event_type: 'usb_transfer' | 'email_attachment' | 'clipboard_exfil',
//   direction?: 'to_external'|'from_external',
//   device_name?, device_serial?, device_type?,
//   mail_provider?, mail_url?, recipient_email?,
//   file_path?, file_name?, file_size_bytes?, file_mime?, file_hash_sha256?,
//   active_window?, screenshot_b64? (optional jpeg, will be uploaded to Storage),
//   occurred_at?
// }
//
// Pipeline:
//   1. Validate enroll_token → resolve org_id + agent_id
//   2. (Optional) upload screenshot to `screenshots` bucket
//   3. Insert dlp_events row
//   4. Synchronously call AI classifier (Anthropic Claude → OpenAI fallback)
//   5. If unauthorized → fire-and-forget email via dlp-alert-email function
//
// AI policies live in `dlp_settings` per-org. Whitelist authorized_domains so
// internal emails to company.com don't fire alerts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

interface DlpEventBody {
  event_type: "usb_transfer" | "email_attachment" | "clipboard_exfil";
  direction?: "to_external" | "from_external" | "unknown";
  device_name?: string;
  device_serial?: string;
  device_type?: string;
  mail_provider?: string;
  mail_url?: string;
  recipient_email?: string;
  file_path?: string;
  file_name?: string;
  file_size_bytes?: number;
  file_mime?: string;
  file_hash_sha256?: string;
  active_window?: string;
  screenshot_b64?: string;
  occurred_at?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const token = req.headers.get("x-agent-token") ?? "";
  if (!token) return json({ error: "missing X-Agent-Token" }, 401);

  let body: DlpEventBody;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.event_type) return json({ error: "event_type required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Resolve agent + org via enroll_token
  const { data: agent, error: agentErr } = await admin
    .from("agents")
    .select("id, org_id, agent_name, dlp_enabled")
    .eq("enroll_token", token)
    .maybeSingle();
  if (agentErr) return json({ error: agentErr.message }, 500);
  if (!agent) return json({ error: "agent not found" }, 404);

  // Per-org settings (whitelist domains, enabled per event-type, AI prompt)
  const { data: settings } = await admin
    .from("dlp_settings").select("*").eq("org_id", agent.org_id).maybeSingle();

  // Honour the per-event-type kill switch. Useful when admins want USB but not email tracking.
  if (settings) {
    if (body.event_type === "usb_transfer"     && !settings.usb_enabled)   return json({ ok: true, skipped: "usb disabled" });
    if (body.event_type === "email_attachment" && !settings.email_enabled) return json({ ok: true, skipped: "email disabled" });
    if (body.event_type === "clipboard_exfil"  && !settings.clipboard_enabled) return json({ ok: true, skipped: "clipboard disabled" });
  }
  if (!agent.dlp_enabled) return json({ ok: true, skipped: "agent dlp disabled" });

  // 2. Upload screenshot if provided
  let screenshot_url: string | null = null;
  if (body.screenshot_b64) {
    try {
      const bin = Uint8Array.from(atob(body.screenshot_b64), (c) => c.charCodeAt(0));
      const path = `${agent.org_id}/${agent.id}/dlp-${Date.now()}.jpg`;
      const { error } = await admin.storage.from("screenshots").upload(path, bin, {
        contentType: "image/jpeg",
        upsert: false,
      });
      if (!error) screenshot_url = path;
    } catch { /* ignore screenshot upload failures — event is more important */ }
  }

  // 3. Insert event row
  const { data: ev, error: evErr } = await admin.from("dlp_events").insert({
    org_id: agent.org_id,
    agent_id: agent.id,
    event_type: body.event_type,
    direction: body.direction ?? null,
    device_name: body.device_name ?? null,
    device_serial: body.device_serial ?? null,
    device_type: body.device_type ?? null,
    mail_provider: body.mail_provider ?? null,
    mail_url: body.mail_url ?? null,
    recipient_email: body.recipient_email ?? null,
    file_path: body.file_path ?? null,
    file_name: body.file_name ?? null,
    file_size_bytes: body.file_size_bytes ?? null,
    file_mime: body.file_mime ?? null,
    file_hash_sha256: body.file_hash_sha256 ?? null,
    active_window: body.active_window ?? null,
    screenshot_url,
    occurred_at: body.occurred_at ?? new Date().toISOString(),
  }).select().single();
  if (evErr) return json({ error: `insert: ${evErr.message}` }, 500);

  // 4. AI classification (async — kick off but don't block ingest)
  // We DO await so the response carries the classification result for the UI's
  // optimistic update; the email send is fire-and-forget.
  const classification = await classify(ev, settings);

  // 5. Persist classification + maybe alert
  await admin.from("dlp_events").update({
    ai_authorized: classification.authorized,
    ai_severity: classification.severity,
    ai_reason: classification.reason,
    ai_model: classification.model,
    ai_processed_at: new Date().toISOString(),
  }).eq("id", ev.id);

  // 6. If unauthorized, trigger email alert (fire-and-forget)
  if (!classification.authorized) {
    fetch(`${SUPABASE_URL}/functions/v1/dlp-alert-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_ROLE_KEY },
      body: JSON.stringify({ event_id: ev.id }),
    }).catch(() => { /* fire-and-forget */ });
  }

  return json({ ok: true, event_id: ev.id, classification });
});

// ---------------------------------------------------------------------------
// AI classification — Anthropic primary, OpenAI fallback
// ---------------------------------------------------------------------------

interface Classification {
  authorized: boolean;
  severity: "low" | "medium" | "high" | "critical";
  reason: string;
  model: string;
}

async function classify(
  ev: Record<string, unknown>,
  settings: Record<string, unknown> | null,
): Promise<Classification> {
  // Default policy is intentionally STRICT — every USB transfer and every
  // attachment to a personal mail provider is treated as unauthorized data
  // movement. Customers narrow this down by adding their company's email
  // domains to authorized_domains, or providing a custom ai_policy_prompt.
  const customPolicy = (settings?.ai_policy_prompt as string | null) ?? null;
  const allowed = (settings?.authorized_domains as string[] | null) ?? [];
  const blocked = (settings?.blocked_keywords as string[] | null) ?? [];
  const allowedStr = allowed.length ? allowed.join(", ") : "(none — every external recipient is unauthorized)";
  const blockedStr = blocked.length ? blocked.join(", ") : "(none)";

  // Quick deterministic check for authorized domain — bypass AI when it's a clear allow.
  const recipientLower = String(ev.recipient_email ?? "").toLowerCase();
  if (recipientLower && allowed.length > 0) {
    if (allowed.some((d) => recipientLower.endsWith("@" + d.toLowerCase()) || recipientLower.endsWith("." + d.toLowerCase()))) {
      return {
        authorized: true,
        severity: "low",
        reason: "Recipient is on the authorized_domains whitelist.",
        model: "rule",
      };
    }
  }

  const eventSummary = JSON.stringify({
    type: ev.event_type,
    direction: ev.direction,
    file_name: ev.file_name,
    file_size_bytes: ev.file_size_bytes,
    file_mime: ev.file_mime,
    device_name: ev.device_name,
    mail_provider: ev.mail_provider,
    recipient_email: ev.recipient_email,
    active_window: ev.active_window,
  });

  const systemPrompt =
    "You are a Data Loss Prevention (DLP) classifier for a workforce monitoring agent. " +
    "Your default stance: ANY file transfer to a USB/removable device is unauthorized data exfiltration, " +
    "and ANY file attached to a personal mail provider (Gmail, Yahoo, Rediffmail, Outlook personal, Hotmail, " +
    "Proton, AOL, Zoho personal) is unauthorized. The file's name or content does NOT need to look 'sensitive' — " +
    "the act of moving company data to external channels is itself unauthorized unless explicitly allowed below.\n\n" +
    `Authorized email domains (recipients on these are LOW severity, authorized=true): ${allowedStr}\n` +
    `Blocked keywords (always CRITICAL severity if matched): ${blockedStr}\n` +
    (customPolicy ? `Customer-specific policy override: ${customPolicy}\n` : "") +
    "\nSeverity guidance:\n" +
    "  - critical: matches a blocked keyword OR file size > 50 MB OR name suggests bulk export (db_dump, customers, payroll, contacts)\n" +
    "  - high:     any USB transfer, any personal-mail attachment with no whitelist match (this is the DEFAULT for unauthorized)\n" +
    "  - medium:   ambiguous case (e.g. file going to a domain that LOOKS corporate but isn't whitelisted)\n" +
    "  - low:      authorized — recipient on whitelist, or transfer to a non-personal-mail destination\n\n" +
    'Respond with ONLY a JSON object: {"authorized": boolean, "severity": "low"|"medium"|"high"|"critical", "reason": "<one short sentence>"}';

  const userPrompt = `Event:\n${eventSummary}`;

  // Try Anthropic first
  if (ANTHROPIC_API_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 256,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (r.ok) {
        const j = await r.json() as { content: { text: string }[] };
        const text = j.content?.[0]?.text ?? "";
        const parsed = parseClassification(text);
        if (parsed) return { ...parsed, model: "claude-haiku-4-5" };
      }
    } catch { /* fall through to OpenAI */ }
  }

  // OpenAI fallback
  if (OPENAI_API_KEY) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 256,
        }),
      });
      if (r.ok) {
        const j = await r.json() as { choices: { message: { content: string } }[] };
        const text = j.choices?.[0]?.message?.content ?? "";
        const parsed = parseClassification(text);
        if (parsed) return { ...parsed, model: "gpt-4o-mini" };
      }
    } catch { /* fall through to default */ }
  }

  // Last-resort heuristic — strict by default so policy is "track everything,
  // whitelist exceptions" rather than "only flag obvious cases".
  const isUsb = ev.event_type === "usb_transfer";
  const isEmailAttach = ev.event_type === "email_attachment";
  const isAuthorizedDomain = recipientLower && allowed.some((d) =>
    recipientLower.endsWith("@" + d.toLowerCase()) || recipientLower.endsWith("." + d.toLowerCase())
  );
  // USB always flagged. Email attachments flagged unless on whitelist.
  const authorized = isAuthorizedDomain && isEmailAttach;
  // Bulk-export cue: file size > 50 MB
  const sz = Number(ev.file_size_bytes ?? 0);
  const isBulk = sz > 50 * 1024 * 1024;
  let severity: Classification["severity"] = authorized ? "low" : "high";
  if (!authorized && isBulk) severity = "critical";
  return {
    authorized,
    severity,
    reason: authorized
      ? "Recipient is on the authorized_domains whitelist."
      : isUsb
        ? "USB transfer to external device — no AI key configured, default-flagged."
        : "Personal-mail attachment — no AI key configured, default-flagged.",
    model: "heuristic",
  };
}

function parseClassification(text: string): Omit<Classification, "model"> | null {
  // Find first JSON object in the response (model may add prose)
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (typeof o.authorized !== "boolean") return null;
    const sev = ["low", "medium", "high", "critical"].includes(o.severity) ? o.severity : "medium";
    return { authorized: !!o.authorized, severity: sev, reason: String(o.reason ?? "") };
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
