// POST /functions/v1/dlp-alert-email
// Body: { event_id: string }
//
// Sends an alert email via Microsoft Graph (app-only / client credentials flow).
// Recipients = dlp_alert_recipients rows for this event's org PLUS any global
// recipients (org_id IS NULL, e.g. Rudrans's own ops team).
//
// Env required (set via `supabase secrets set ...`):
//   MICROSOFT_TENANT_ID            — Azure AD tenant ID (GUID)
//   MICROSOFT_CLIENT_ID            — App registration client ID
//   MICROSOFT_CLIENT_SECRET        — App registration client secret
//   MICROSOFT_SENDER_UPN           — Mailbox UPN that sends the alerts
//                                     (must have a Microsoft 365 license,
//                                      e.g. "alerts@yourcompany.onmicrosoft.com")
//
// Required Graph permission (admin consent):
//   Mail.Send  (Application)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegrations } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Token cache (in-process — Deno edge functions are reused across requests for ~5 min)
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getGraphToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const cfg = await getIntegrations(["MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]);
  const TENANT_ID = cfg.MICROSOFT_TENANT_ID;
  const CLIENT_ID = cfg.MICROSOFT_CLIENT_ID;
  const CLIENT_SECRET = cfg.MICROSOFT_CLIENT_SECRET;
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Microsoft Graph not configured (missing TENANT_ID/CLIENT_ID/CLIENT_SECRET in /admin/integrations)");
  }
  const r = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`graph token: ${r.status} ${t}`);
  }
  const j = await r.json() as { access_token: string; expires_in: number };
  cachedToken = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // SECURITY (audit M19): this is an INTERNAL server-to-server function
  // (dlp-ingest invokes it with the service-role key). It runs as service_role,
  // returns the org's + global alert recipient list, and mints a signed
  // screenshot URL — none of which should be reachable by a caller holding only
  // the public anon key. Require the service-role key. dlp-ingest already sends
  // it as the `apikey` header; also accept it as a bearer token.
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const apikey = req.headers.get("apikey") ?? "";
  if (bearer !== SERVICE_ROLE_KEY && apikey !== SERVICE_ROLE_KEY) {
    return json({ error: "forbidden" }, 403);
  }

  let body: { event_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.event_id) return json({ error: "event_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Pull event with joined agent + org info
  const { data: ev, error: evErr } = await admin
    .from("dlp_events")
    .select("*, agents(agent_name, machine_name, department), organizations(name)")
    .eq("id", body.event_id)
    .maybeSingle();
  if (evErr) return json({ error: evErr.message }, 500);
  if (!ev) return json({ error: "event not found" }, 404);
  if (ev.alert_sent_at) return json({ ok: true, already_sent: ev.alert_sent_at });

  // Recipients: org-specific + global, filtered by severity subscription
  const sev = ev.ai_severity ?? "high";
  const { data: orgRecipients } = await admin
    .from("dlp_alert_recipients")
    .select("email, full_name, severities")
    .eq("org_id", ev.org_id)
    .eq("is_active", true);
  const { data: globalRecipients } = await admin
    .from("dlp_alert_recipients")
    .select("email, full_name, severities")
    .is("org_id", null)
    .eq("is_active", true);

  const all = [...(orgRecipients ?? []), ...(globalRecipients ?? [])]
    .filter((r) => (r.severities as string[]).includes(sev));
  if (all.length === 0) return json({ ok: true, skipped: "no recipients for severity " + sev });

  // Signed URL for screenshot if any
  let screenshotUrl: string | null = null;
  if (ev.screenshot_url) {
    const { data: signed } = await admin.storage.from("screenshots")
      .createSignedUrl(ev.screenshot_url as string, 3600 * 24 * 7);  // 7 days
    screenshotUrl = signed?.signedUrl ?? null;
  }

  const subject = `[Rudrans DLP] ${sev.toUpperCase()} — ${ev.event_type} — ${ev.organizations?.name ?? "Unknown org"}`;
  const html = renderEmail(ev, screenshotUrl);

  // Send via Microsoft Graph
  let token: string;
  try { token = await getGraphToken(); }
  catch (e) { return json({ error: (e as Error).message }, 500); }

  const { MICROSOFT_SENDER_UPN: SENDER_UPN = "" } = await getIntegrations(["MICROSOFT_SENDER_UPN"]);
  if (!SENDER_UPN) return json({ error: "MICROSOFT_SENDER_UPN not configured in /admin/integrations" }, 500);
  const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER_UPN)}/sendMail`;
  const r = await fetch(sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: all.map((rr) => ({ emailAddress: { address: rr.email, name: rr.full_name ?? undefined } })),
      },
      saveToSentItems: true,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    return json({ error: `graph sendMail: ${r.status} ${t}` }, 500);
  }

  await admin.from("dlp_events").update({
    alert_sent_at: new Date().toISOString(),
    alert_email: all.map((x) => x.email).join(","),
  }).eq("id", ev.id);

  return json({ ok: true, sent_to: all.map((x) => x.email) });
});

function renderEmail(ev: Record<string, unknown>, screenshotUrl: string | null): string {
  const a = (ev.agents as { agent_name?: string; machine_name?: string; department?: string }) ?? {};
  const o = (ev.organizations as { name?: string }) ?? {};
  const sev = (ev.ai_severity as string ?? "high").toUpperCase();
  const sevColor = sev === "CRITICAL" ? "#dc2626" : sev === "HIGH" ? "#ea580c" : sev === "MEDIUM" ? "#ca8a04" : "#65a30d";
  const fmt = (k: string, v: unknown) => v ? `<tr><td style="padding:6px 12px;color:#64748b;">${k}</td><td style="padding:6px 12px;color:#0f172a;">${String(v)}</td></tr>` : "";

  return `
<div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 640px; margin: 0 auto; background:#f8fafc; padding:20px;">
  <div style="background:white; border-radius:12px; overflow:hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08);">
    <div style="background:${sevColor}; color:white; padding:16px 20px;">
      <p style="margin:0; font-size:11px; opacity:0.85; letter-spacing:0.05em;">DLP ALERT · ${sev}</p>
      <h1 style="margin:6px 0 0; font-size:20px;">${(ev.event_type as string).replace(/_/g, " ").toUpperCase()}</h1>
    </div>
    <div style="padding:20px;">
      <p style="margin:0 0 12px; color:#475569;">${ev.ai_reason ?? "Activity flagged for review."}</p>
      <table style="width:100%; border-collapse:collapse; font-size:13px; background:#f8fafc; border-radius:8px; overflow:hidden;">
        ${fmt("Organisation",  o.name)}
        ${fmt("Agent",         a.agent_name)}
        ${fmt("Machine",       a.machine_name)}
        ${fmt("Department",    a.department)}
        ${fmt("File",          ev.file_name ?? ev.file_path)}
        ${fmt("File size",     ev.file_size_bytes ? formatBytes(ev.file_size_bytes as number) : null)}
        ${fmt("Mail provider", ev.mail_provider)}
        ${fmt("Recipient",     ev.recipient_email)}
        ${fmt("Device",        ev.device_name)}
        ${fmt("When",          new Date(ev.occurred_at as string).toLocaleString("en-IN"))}
        ${fmt("Active window", ev.active_window)}
      </table>
      ${screenshotUrl ? `<div style="margin-top:16px;"><p style="margin:0 0 8px; font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.05em;">Screenshot at the time</p><img src="${screenshotUrl}" alt="" style="width:100%; border-radius:8px; border:1px solid #e2e8f0;"/></div>` : ""}
      <p style="margin-top:20px; font-size:12px; color:#94a3b8;">
        This alert was generated by Rudrans DLP. AI model: ${ev.ai_model ?? "—"}.
      </p>
    </div>
  </div>
</div>`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
