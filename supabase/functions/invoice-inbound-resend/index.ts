// POST /functions/v1/invoice-inbound-resend
// Resend Inbound webhook receiver. Resend POSTs the parsed email here
// whenever someone sends to a `*@invoices.wellnessextract.com` address that's
// forwarded into our Resend Inbound endpoint.
//
// Resend signs the request with Svix-style headers — we verify against
// the `RESEND_WEBHOOK_SECRET` integration row (set via /admin/integrations
// → Email category, or whatever category we pick).
//
// We translate Resend's payload to the same shape `invoice-inbound`
// already accepts, then run the same storage + credential-match + event
// logging logic by calling the shared helper.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegration } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface ResendEvent {
  type?: string;
  data?: {
    from?: { address?: string };
    to?: Array<{ address?: string }>;
    subject?: string;
    created_at?: string;
    attachments?: Array<{
      filename?: string;
      content_type?: string;
      content?: string;          // base64
    }>;
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const raw = await req.text();

  // ── Verify Resend webhook signature (Svix format) ───────────────────
  // Headers: svix-id, svix-timestamp, svix-signature: "v1,<base64sig>"
  const svixId = req.headers.get("svix-id") ?? "";
  const svixTs = req.headers.get("svix-timestamp") ?? "";
  const svixSig = req.headers.get("svix-signature") ?? "";

  const secret = await getIntegration("RESEND_WEBHOOK_SECRET").catch(() => "");
  if (!secret) return json({ error: "RESEND_WEBHOOK_SECRET not configured" }, 500);

  if (!svixId || !svixTs || !svixSig) return json({ error: "missing svix headers" }, 401);
  if (Math.abs(Date.now() / 1000 - Number(svixTs)) > 60 * 5) {
    return json({ error: "stale request" }, 401);
  }

  // Resend secret format: `whsec_<base64-key>` — strip prefix, decode.
  const keyB64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Uint8Array;
  try { keyBytes = base64Decode(keyB64); } catch { return json({ error: "bad secret format" }, 500); }
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${svixId}.${svixTs}.${raw}`)),
  );
  const expectedB64 = base64Encode(expected);
  // svix-signature may contain multiple "v1,<sig>" pairs space-separated.
  const ok = svixSig.split(" ").some((p) => {
    const [ver, sig] = p.split(",");
    return ver === "v1" && constantTimeEq(sig, expectedB64);
  });
  if (!ok) return json({ error: "bad signature" }, 401);

  // ── Parse + translate payload ───────────────────────────────────────
  let body: ResendEvent;
  try { body = JSON.parse(raw); } catch { return json({ error: "invalid json" }, 400); }
  if (body.type && !["email.received", "email.delivered"].includes(body.type)) {
    return json({ ok: true, ignored: body.type }, 200);
  }
  const d = body.data ?? {};
  const toAddr = d.to?.[0]?.address ?? "";
  const fromAddr = d.from?.address ?? "";

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Match credential and upload (same logic as invoice-inbound) ─────
  // Accepts the new 8-hex slug (migration 0096) or the legacy full UUID.
  const orgId = await resolveInboundOrg(admin, toAddr);
  if (!orgId) return json({ error: `unrecognised To: ${toAddr}` }, 400);

  const pdfs = (d.attachments ?? []).filter(
    (a) => a.content_type?.toLowerCase().includes("pdf")
      || a.filename?.toLowerCase().endsWith(".pdf"),
  );
  if (pdfs.length === 0) return json({ ok: true, note: "no PDF attachment" }, 200);

  // Credential picker (mirrors invoice-inbound logic).
  const senderDomain = fromAddr.toLowerCase().split("@").pop() ?? "";
  const baseDomain = senderDomain.split(".").slice(-2).join(".");
  const { data: creds } = await admin
    .from("credentials")
    .select("id, platform_name, login_url")
    .eq("org_id", orgId)
    .eq("active", true);
  if (!creds?.length) return json({ error: "no credentials in org" }, 404);

  const subj = (d.subject ?? "").toLowerCase();
  const cred =
    creds.find((c) => (c.login_url ?? "").toLowerCase().includes(baseDomain))
    ?? creds.find((c) => {
      const name = (c.platform_name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return name && (baseDomain.includes(name) || subj.includes(name));
    });
  if (!cred) return json({ error: `no credential match for ${baseDomain}` }, 404);

  const created: string[] = [];
  for (const att of pdfs) {
    const bytes = base64Decode(att.content ?? "");
    const invoiceId = crypto.randomUUID();
    const path = `${orgId}/${cred.id}/${invoiceId}.pdf`;
    const { error: upErr } = await admin.storage.from("credential-invoices").upload(path, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (upErr) return json({ error: `storage: ${upErr.message}` }, 500);

    const issueDate = (d.created_at ?? new Date().toISOString()).slice(0, 10);
    const { error: insErr } = await admin.from("credential_invoices").insert({
      id: invoiceId,
      org_id: orgId,
      credential_id: cred.id,
      external_id: `email:${invoiceId}`,
      invoice_number: guessInvoiceNumber(d.subject ?? "", att.filename ?? ""),
      issue_date: issueDate,
      status: "pending",
      source: "email",
      attachment_path: path,
      attachment_mime: "application/pdf",
      attachment_name: att.filename ?? null,
      raw: { from: fromAddr, subject: d.subject, via: "resend" },
    });
    if (insErr) return json({ error: `insert: ${insErr.message}` }, 500);
    created.push(invoiceId);

    // Close any open job for this credential's current period.
    await admin
      .from("invoice_fetch_jobs")
      .update({ status: "success", result_invoice_id: invoiceId, completed_at: new Date().toISOString() })
      .eq("credential_id", cred.id)
      .in("status", ["queued", "running", "needs_otp"])
      .lte("billing_period_start", issueDate);

    // Event log.
    const { logEvent } = await import("../_shared/event-log.ts");
    await logEvent({
      orgId, credentialId: cred.id, invoiceId,
      kind: "tier_email_received", actor: "webhook", channel: "resend",
      message: `Email from ${fromAddr}: PDF saved (${att.filename ?? "invoice.pdf"})`,
      detail: { from: fromAddr, subject: d.subject, filename: att.filename },
    });
  }

  await admin.from("credentials").update({
    last_fetch_attempt_at: new Date().toISOString(),
  }).eq("id", cred.id);

  return json({ ok: true, credential_id: cred.id, invoices: created }, 200);
});

function guessInvoiceNumber(subject: string, filename: string): string | null {
  const re = /(inv[-_# ]?|invoice[-_# ]?)([a-z0-9-]{4,})/i;
  return (subject.match(re) ?? filename.match(re))?.[2] ?? null;
}

function base64Decode(b64: string): Uint8Array {
  const pure = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(pure);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function base64Encode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}
// Resolve org from inv-<slug>@invoices.wellnessextract.com (new) or
// inv-<full-uuid>@invoices.wellnessextract.com (legacy). Mirror of the helper in
// supabase/functions/invoice-inbound/index.ts — kept duplicated rather
// than putting in _shared/ because the two functions are independently
// versioned and shipping a shared change requires redeploying both.
// deno-lint-ignore no-explicit-any
async function resolveInboundOrg(admin: any, to: string): Promise<string | null> {
  const local = to.match(/^inv-([a-z0-9-]+)@/i)?.[1]?.toLowerCase();
  if (!local) return null;
  if (/^[0-9a-f]{8}$/.test(local)) {
    const { data } = await admin
      .from("organizations").select("id").eq("invoice_inbound_slug", local).maybeSingle();
    if (data?.id) return data.id as string;
  }
  if (/^[0-9a-f-]{36}$/.test(local)) {
    const { data } = await admin
      .from("organizations").select("id").eq("id", local).maybeSingle();
    if (data?.id) return data.id as string;
  }
  return null;
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
