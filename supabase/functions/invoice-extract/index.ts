// POST /functions/v1/invoice-extract
// Headers: Authorization: Bearer <user JWT>
// Body:    { pdf_base64: string, filename?: string }
//
// Sends the PDF to Claude (sonnet-4-5) with a structured-extraction
// prompt. Returns:
//   {
//     invoice_number, issue_date (YYYY-MM-DD), period_start, period_end,
//     due_date, amount, currency, status, vendor_name, vendor_domain,
//     matched_credential_id?  -- guessed by vendor_name / domain match
//                                 against the caller's credentials
//   }
//
// Claude API key comes from the integrations table (`ANTHROPIC_API_KEY`,
// managed via /admin/integrations) — never from .env. This is a SaaS:
// rotate from portal without redeploying.
//
// Cost: ~1 Claude call per upload, ~$0.02-0.05 per PDF depending on size.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { getIntegration } from "../_shared/integrations.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const MODEL = "claude-sonnet-4-5";

const SYSTEM = `Extract structured invoice fields from the attached PDF and output ONE JSON object — no prose, no markdown fence.

Shape (every field optional; emit null if not on the document):
{
  "invoice_number": "INV-2025-0042" | null,
  "issue_date":     "YYYY-MM-DD"  | null,
  "period_start":   "YYYY-MM-DD"  | null,
  "period_end":     "YYYY-MM-DD"  | null,
  "due_date":       "YYYY-MM-DD"  | null,
  "amount":         <number>      | null,
  "currency":       "USD"|"INR"|"EUR"... | null,
  "status":         "paid"|"pending"|"overdue"|"failed"|"refunded"|"draft" | null,
  "vendor_name":    "Adobe Inc."  | null,
  "vendor_domain":  "adobe.com"   | null,
  "notes":          "1-line summary if helpful" | null
}

Rules:
- Dates must be ISO YYYY-MM-DD. Convert "Sep 14, 2025" → "2025-09-14".
- Amount: total/grand-total numeric, no currency symbol. If multiple lines, pick the final due amount.
- Currency: ISO 4217 code (INR, USD, etc.).
- vendor_domain: the sender / company's web domain (e.g. "razorpay.com"), used downstream to match against the customer's stored credentials.
- If the document is clearly not an invoice (receipt, statement, marketing PDF), return all-null fields and put a note explaining what it actually is.`;

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

  const apiKey = await getIntegration("ANTHROPIC_API_KEY").catch(() => "");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set in /admin/integrations" }, 500);

  // ── Call Claude with the PDF attached ───────────────────────────────
  const claudeR = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          isPdf
            ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
            : { type: "image",    source: { type: "base64", media_type: claudeMedia,        data: b64 } },
          { type: "text", text: "Extract fields per spec. Output one JSON object only." },
        ],
      }],
    }),
  });
  if (!claudeR.ok) {
    const detail = (await claudeR.text()).slice(0, 400);
    return json({ error: `claude ${claudeR.status}: ${detail}` }, 502);
  }
  const claudeJ = await claudeR.json() as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = claudeJ.content.find((c) => c.type === "text")?.text ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) return json({ error: "no JSON in claude output" }, 502);
  let parsed: Extracted;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch (e) { return json({ error: `parse: ${(e as Error).message}` }, 502); }

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
