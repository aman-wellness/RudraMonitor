// POST /functions/v1/invoice-extract
// Headers: Authorization: Bearer <user JWT>
// Body:    { pdf_base64: string, filename?: string, mime_type?: string }
//
// Hands the PDF / image off to the self-hosted AI sidecar
// (rudrans-ai-sidecar on the same EC2 box, port 8081). The sidecar
// OCRs the file (pdftotext / tesseract) and runs the extraction
// through a local Ollama model. Returns:
//   {
//     invoice_number, issue_date (YYYY-MM-DD), period_start, period_end,
//     due_date, amount, currency, status, vendor_name, vendor_domain,
//     matched_credential_id?  -- guessed by vendor_name / domain match
//                                 against the caller's credentials
//   }
//
// Why this replaced Claude: paid Anthropic credits ran out and feature
// went dead. Local OCR + small LLM costs nothing per call and the
// extraction quality on B2B SaaS invoices (Adobe, AWS, Razorpay, ...)
// is comparable. See plan: is-tool-ko-app-crystalline-biscuit.md.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const SIDECAR_URL = Deno.env.get("AI_SIDECAR_URL") ?? "http://172.17.0.1:8081";
const SIDECAR_TOKEN = Deno.env.get("AI_SIDECAR_TOKEN") ?? "";

interface Extracted {
  invoice_number: string | null;
  issue_date: string | null;
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  amount: number | null;
  currency: string | null;
  status: "paid" | "pending" | "overdue" | "failed" | "refunded" | "draft" | null;
  vendor_name: string | null;
  vendor_domain: string | null;
  notes: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  // `pdf_base64` is historical — kept as the field name so the existing
  // web upload (PDFs) doesn't need to change. The mobile app sends JPEG
  // photos with `mime_type: 'image/jpeg'`; Claude vision treats them as
  // the `image` content type. PNG also accepted.
  let body: { pdf_base64?: string; filename?: string; mime_type?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const b64 = (body.pdf_base64 ?? "").replace(/^data:[^;]+;base64,/, "");
  if (!b64) return json({ error: "pdf_base64 required" }, 400);
  if (b64.length > 28_000_000) {        // ~20 MB raw
    return json({ error: "file too large (max 20 MB)" }, 413);
  }
  // Validate mime — default to PDF for backward-compat with the web UI.
  const mime = (body.mime_type ?? "application/pdf").toLowerCase();
  // Claude vision supports image/jpeg, image/png, image/gif, image/webp.
  // HEIC/HEIF (iPhone native) aren't accepted by Claude — but Capacitor
  // converts to JPEG on capture, so this only matters for direct uploads.
  const isImage =
    mime === "image/jpeg" || mime === "image/jpg" ||
    mime === "image/png"  || mime === "image/webp" ||
    mime === "image/gif";
  const isPdf = mime === "application/pdf";
  if (!isImage && !isPdf) {
    if (mime.startsWith("image/heic") || mime.startsWith("image/heif")) {
      return json({ error: "HEIC/HEIF not supported by Claude vision — save as JPEG first" }, 400);
    }
    return json({ error: `unsupported mime_type ${mime} (expect application/pdf or image/jpeg|png|gif|webp)` }, 400);
  }
  // Claude API uses image/jpeg, not image/jpg; normalise.
  const claudeMedia = mime === "image/jpg" ? "image/jpeg" : mime;

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: mem } = await admin.from("org_members")
    .select("org_id").eq("user_id", u.user.id).limit(1).maybeSingle();
  if (!mem) return json({ error: "no org for caller" }, 403);
  const orgId = mem.org_id as string;

  if (!SIDECAR_TOKEN) return json({ error: "AI_SIDECAR_TOKEN not set in edge env" }, 500);

  // ── Call the self-hosted AI sidecar ─────────────────────────────────
  // The sidecar (rudrans-ai-sidecar at /opt/rudrans-ai on this same EC2
  // box) handles OCR + LLM extraction with a local Ollama model. We pass
  // the same base64 + mime payload; it returns the identical Extracted
  // shape the old Claude path produced, so the vendor-match block below
  // and the frontend consumer don't change.
  let parsed: Extracted;
  try {
    const r = await fetch(`${SIDECAR_URL}/extract-invoice`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${SIDECAR_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mime_type: claudeMedia, data_b64: b64 }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 400);
      return json({ error: `local-ai ${r.status}: ${detail}` }, 502);
    }
    const body = await r.json() as { extracted?: Extracted };
    if (!body.extracted) return json({ error: "sidecar returned no extracted field" }, 502);
    parsed = body.extracted;
  } catch (e) {
    return json({ error: `sidecar fetch: ${(e as Error).message}` }, 502);
  }

  // ── Match vendor to credential (best-effort) ────────────────────────
  let matchedCredId: string | null = null;
  let matchedPlatform: string | null = null;
  const { data: creds } = await admin
    .from("credentials")
    .select("id, platform_name, login_url")
    .eq("org_id", orgId)
    .eq("active", true);
  if (creds?.length) {
    const dom = (parsed.vendor_domain ?? "").toLowerCase();
    const baseDom = dom.split(".").slice(-2).join(".");
    // 1. URL host contains vendor base-domain.
    let hit = creds.find((c) => baseDom && (c.login_url ?? "").toLowerCase().includes(baseDom));
    // 2. Platform name fuzzy-match against vendor_name.
    if (!hit && parsed.vendor_name) {
      const vn = parsed.vendor_name.toLowerCase().replace(/[^a-z0-9]/g, "");
      hit = creds.find((c) => {
        const pn = (c.platform_name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        return pn && vn && (vn.includes(pn) || pn.includes(vn));
      });
    }
    if (hit) { matchedCredId = hit.id; matchedPlatform = hit.platform_name; }
  }

  return json({
    ok: true,
    extracted: parsed,
    matched_credential_id: matchedCredId,
    matched_credential_platform: matchedPlatform,
  }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
