// POST /functions/v1/invoice-sync
// Headers: Authorization: Bearer <user JWT>  OR  Bearer <service-role key>
// Body: { credential_id: string, period_start?: string, period_end?: string }
//
// Decrypts the credential's stored billing-API token and pulls every invoice
// the provider returns, upserting into credential_invoices by external_id.
// Idempotent — re-running just refreshes statuses on existing rows.
//
// When called by the cron dispatcher with service-role and period_*, also
// returns the credential_invoices row id (if any) whose issue_date or
// period_start matches the requested billing period, so the job queue can
// store result_invoice_id.
//
// Supported providers:
//   • stripe   — GET /v1/invoices (Bearer secret key)
//   • razorpay — GET /v1/invoices (Basic key_id:key_secret)
//   • openai   — GET /v1/dashboard/billing/invoices (org-scoped)
//   • zoom     — GET /v2/accounts/me/billing/invoices (Server-to-Server OAuth)
//
// AWS / Anthropic: still no public per-org invoice API — surface a clear
// error so the UI shows "manual upload" guidance.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { decrypt } from "../_shared/crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface InvoiceUpsert {
  external_id: string;
  invoice_number: string | null;
  issue_date: string | null;          // YYYY-MM-DD
  period_start: string | null;
  period_end: string | null;
  due_date: string | null;
  amount: number | null;
  currency: string | null;
  status: "paid" | "pending" | "overdue" | "failed" | "refunded" | "draft";
  pdf_url: string | null;
  raw: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = bearer(req);
  if (!jwt) return json({ error: "missing token" }, 401);

  let body: { credential_id?: string; period_start?: string; period_end?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const credId = (body.credential_id ?? "").trim();
  if (!credId) return json({ error: "credential_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: cred } = await admin
    .from("credentials")
    .select("id, org_id, platform_name, billing_api_provider, billing_api_token_enc")
    .eq("id", credId).maybeSingle();
  if (!cred) return json({ error: "credential not found" }, 404);

  // Two auth paths: service-role (internal dispatcher) or user JWT (UI button).
  const isServiceRole = jwt === SERVICE_ROLE_KEY;
  if (!isServiceRole) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return json({ error: "invalid token" }, 401);
    const { data: mem } = await admin.from("org_members").select("org_id")
      .eq("user_id", u.user.id).eq("org_id", cred.org_id);
    if (!mem?.length) return json({ error: "not authorised for this org" }, 403);
  }
  if (!cred.billing_api_provider) return json({ error: "no billing API provider set for this credential" }, 400);
  if (!cred.billing_api_token_enc) return json({ error: "no API token connected — use 'Connect API token' first" }, 400);

  // Decrypt the secret once. For razorpay this is JSON({key_id, key_secret}).
  let secret: string;
  try {
    secret = await decrypt(cred.billing_api_token_enc, "CRED_VAULT_ENC_KEY");
  } catch (e) {
    return json({ error: `decrypt: ${(e as Error).message}` }, 500);
  }

  let pulled: InvoiceUpsert[] = [];
  try {
    if (cred.billing_api_provider === "stripe") {
      pulled = await pullStripe(secret);
    } else if (cred.billing_api_provider === "razorpay") {
      pulled = await pullRazorpay(secret);
    } else if (cred.billing_api_provider === "openai") {
      pulled = await pullOpenAI(secret);
    } else if (cred.billing_api_provider === "zoom") {
      pulled = await pullZoom(secret);
    } else {
      return json({
        error: `Provider '${cred.billing_api_provider}' doesn't have a public invoice API. Use CSV upload or manual entry for now.`,
      }, 400);
    }
  } catch (e) {
    const msg = (e as Error).message;
    await admin.from("credentials").update({
      billing_api_last_synced_at: new Date().toISOString(),
      billing_api_last_sync_error: msg,
    }).eq("id", credId);
    return json({ error: msg }, 502);
  }

  // Upsert into credential_invoices. We dedupe by (credential_id, external_id)
  // via the unique index from migration 0043.
  let imported = 0, updated = 0;
  for (const inv of pulled) {
    const row = {
      org_id: cred.org_id,
      credential_id: cred.id,
      external_id: inv.external_id,
      invoice_number: inv.invoice_number,
      issue_date: inv.issue_date,
      period_start: inv.period_start,
      period_end: inv.period_end,
      due_date: inv.due_date,
      amount: inv.amount,
      currency: inv.currency,
      status: inv.status,
      pdf_url: inv.pdf_url,
      raw: inv.raw,
      source: `api_${cred.billing_api_provider}`,
    };
    // Check if exists.
    const { data: existing } = await admin
      .from("credential_invoices")
      .select("id")
      .eq("credential_id", cred.id)
      .eq("external_id", inv.external_id)
      .maybeSingle();
    if (existing) {
      await admin.from("credential_invoices").update(row).eq("id", existing.id);
      updated++;
    } else {
      await admin.from("credential_invoices").insert(row);
      imported++;
    }
  }

  await admin.from("credentials").update({
    billing_api_last_synced_at: new Date().toISOString(),
    billing_api_last_sync_error: null,
    billing_api_meta: { last_count: pulled.length },
    last_fetch_attempt_at: new Date().toISOString(),
  }).eq("id", credId);

  // If called for a specific billing period (cron dispatcher), find the
  // matching just-synced invoice so the job queue can store its id.
  let matched_invoice_id: string | null = null;
  if (body.period_start && body.period_end) {
    const { data: m } = await admin
      .from("credential_invoices")
      .select("id")
      .eq("credential_id", credId)
      .or(`period_start.eq.${body.period_start},and(issue_date.gte.${body.period_start},issue_date.lte.${body.period_end})`)
      .order("issue_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    matched_invoice_id = m?.id ?? null;
  }

  return json({ ok: true, total: pulled.length, imported, updated, matched_invoice_id }, 200);
});

// ============== Stripe ==============
//
// GET /v1/invoices?limit=100 with optional starting_after pagination.
// Auth: Bearer <secret-key>. The customer's *secret* API key, not publishable.

async function pullStripe(secret: string): Promise<InvoiceUpsert[]> {
  const out: InvoiceUpsert[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 50; page++) {           // cap at ~5000 invoices to avoid runaway
    const url = new URL("https://api.stripe.com/v1/invoices");
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!r.ok) throw new Error(`stripe: ${r.status} ${await r.text()}`);
    const j = await r.json() as {
      data: Array<{
        id: string;
        number: string | null;
        status: string;
        amount_paid: number;
        amount_due: number;
        currency: string;
        period_start: number; period_end: number;
        due_date: number | null;
        created: number;
        invoice_pdf: string | null;
      }>;
      has_more: boolean;
    };
    for (const inv of j.data) {
      out.push({
        external_id: inv.id,
        invoice_number: inv.number,
        issue_date: tsToDate(inv.created),
        period_start: tsToDate(inv.period_start),
        period_end: tsToDate(inv.period_end),
        due_date: tsToDate(inv.due_date),
        amount: inv.status === "paid" ? inv.amount_paid / 100 : inv.amount_due / 100,
        currency: inv.currency.toUpperCase(),
        status: mapStripeStatus(inv.status),
        pdf_url: inv.invoice_pdf,
        raw: inv as unknown as Record<string, unknown>,
      });
    }
    if (!j.has_more || j.data.length === 0) break;
    startingAfter = j.data[j.data.length - 1].id;
  }
  return out;
}

function mapStripeStatus(s: string): InvoiceUpsert["status"] {
  if (s === "paid") return "paid";
  if (s === "open") return "pending";
  if (s === "draft") return "draft";
  if (s === "uncollectible") return "failed";
  if (s === "void") return "refunded";
  return "pending";
}

// ============== Razorpay ==============
//
// GET /v1/invoices?count=100&skip=N with Basic auth using key_id:key_secret.
// We stored both as a JSON blob — unpack first.

async function pullRazorpay(secretJson: string): Promise<InvoiceUpsert[]> {
  const { key_id, key_secret } = JSON.parse(secretJson) as { key_id: string; key_secret: string };
  if (!key_id || !key_secret) throw new Error("razorpay key_id / key_secret missing in stored token");
  const auth = btoa(`${key_id}:${key_secret}`);

  const out: InvoiceUpsert[] = [];
  let skip = 0;
  const count = 100;
  for (let page = 0; page < 50; page++) {
    const r = await fetch(`https://api.razorpay.com/v1/invoices?count=${count}&skip=${skip}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!r.ok) throw new Error(`razorpay: ${r.status} ${await r.text()}`);
    const j = await r.json() as {
      items: Array<{
        id: string;
        invoice_number: string | null;
        status: string;
        amount: number;
        amount_paid: number;
        currency: string;
        issued_at: number | null;
        date: number;                      // creation time (unix)
        due_by: number | null;
        short_url: string | null;
      }>;
      count: number;
    };
    for (const inv of j.items) {
      out.push({
        external_id: inv.id,
        invoice_number: inv.invoice_number,
        issue_date: tsToDate(inv.issued_at ?? inv.date),
        period_start: null,
        period_end: null,
        due_date: tsToDate(inv.due_by),
        amount: (inv.status === "paid" ? inv.amount_paid : inv.amount) / 100,
        currency: inv.currency,
        status: mapRazorpayStatus(inv.status),
        pdf_url: inv.short_url,
        raw: inv as unknown as Record<string, unknown>,
      });
    }
    if (j.items.length < count) break;
    skip += count;
  }
  return out;
}

function mapRazorpayStatus(s: string): InvoiceUpsert["status"] {
  if (s === "paid") return "paid";
  if (s === "issued" || s === "partially_paid") return "pending";
  if (s === "draft") return "draft";
  if (s === "cancelled") return "refunded";
  if (s === "expired") return "failed";
  return "pending";
}

// ============== OpenAI (Platform) ==============
//
// GET /v1/dashboard/billing/invoices?organization_id=org_xxx  (Bearer sk-…)
// The token stored in the vault must be a *platform* secret key with billing
// scope (sk-…) and the credential's billing_api_meta should contain
// { organization_id: "org_xxx" }. We pass the org id via the query string.
//
// The endpoint is undocumented but stable since 2024; if OpenAI removes it,
// fall back to manual upload via the UI.

async function pullOpenAI(secret: string): Promise<InvoiceUpsert[]> {
  // The vault may store either a bare key or JSON({api_key, organization_id}).
  let apiKey = secret;
  let orgId: string | undefined;
  try {
    const j = JSON.parse(secret) as { api_key?: string; organization_id?: string };
    if (j.api_key) { apiKey = j.api_key; orgId = j.organization_id; }
  } catch { /* bare key */ }

  const url = new URL("https://api.openai.com/v1/dashboard/billing/invoices");
  if (orgId) url.searchParams.set("organization_id", orgId);

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw new Error(`openai: ${r.status} ${await r.text()}`);
  const j = await r.json() as {
    data?: Array<{
      id: string;
      number?: string | null;
      created_at: number;
      period_start?: number;
      period_end?: number;
      amount_due?: number;
      amount_paid?: number;
      currency?: string;
      status?: string;
      hosted_invoice_url?: string | null;
      invoice_pdf?: string | null;
    }>;
  };
  return (j.data ?? []).map((inv) => ({
    external_id: inv.id,
    invoice_number: inv.number ?? null,
    issue_date: tsToDate(inv.created_at),
    period_start: tsToDate(inv.period_start),
    period_end: tsToDate(inv.period_end),
    due_date: null,
    amount: ((inv.amount_paid ?? inv.amount_due ?? 0) / 100) || null,
    currency: (inv.currency ?? "USD").toUpperCase(),
    status: mapStripeStatus(inv.status ?? "open"),  // OpenAI uses Stripe statuses
    pdf_url: inv.invoice_pdf ?? inv.hosted_invoice_url ?? null,
    raw: inv as unknown as Record<string, unknown>,
  }));
}

// ============== Zoom ==============
//
// Server-to-Server OAuth: vault stores JSON({account_id, client_id, client_secret}).
// We exchange for a short-lived access token, then call the billing endpoint.
// Zoom requires the "Billing" scope on the S2S OAuth app.

async function pullZoom(secretJson: string): Promise<InvoiceUpsert[]> {
  const { account_id, client_id, client_secret } = JSON.parse(secretJson) as {
    account_id: string; client_id: string; client_secret: string;
  };
  if (!account_id || !client_id || !client_secret) {
    throw new Error("zoom: account_id / client_id / client_secret missing in stored token");
  }
  const basic = btoa(`${client_id}:${client_secret}`);
  const tokR = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(account_id)}`,
    { method: "POST", headers: { Authorization: `Basic ${basic}` } },
  );
  if (!tokR.ok) throw new Error(`zoom token: ${tokR.status} ${await tokR.text()}`);
  const { access_token } = await tokR.json() as { access_token: string };

  const out: InvoiceUpsert[] = [];
  // Page through up to 12 months.
  const r = await fetch(
    `https://api.zoom.us/v2/accounts/me/billing/invoices?page_size=300`,
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  if (!r.ok) throw new Error(`zoom invoices: ${r.status} ${await r.text()}`);
  const j = await r.json() as {
    invoices?: Array<{
      invoice_number: string;
      invoice_date: string;        // YYYY-MM-DD
      due_date?: string;
      target_date?: string;        // period end
      amount: number;
      balance?: number;
      currency: string;
      status: string;
      hostedinvoice_url?: string;
    }>;
  };
  for (const inv of (j.invoices ?? [])) {
    out.push({
      external_id: inv.invoice_number,
      invoice_number: inv.invoice_number,
      issue_date: inv.invoice_date ?? null,
      period_start: null,
      period_end: inv.target_date ?? null,
      due_date: inv.due_date ?? null,
      amount: inv.amount,
      currency: (inv.currency ?? "USD").toUpperCase(),
      status: mapZoomStatus(inv.status),
      pdf_url: inv.hostedinvoice_url ?? null,
      raw: inv as unknown as Record<string, unknown>,
    });
  }
  return out;
}

function mapZoomStatus(s: string): InvoiceUpsert["status"] {
  const x = (s ?? "").toLowerCase();
  if (x === "paid") return "paid";
  if (x === "pending" || x === "open") return "pending";
  if (x === "overdue") return "overdue";
  if (x === "failed") return "failed";
  return "pending";
}

// ============== helpers ==============

function tsToDate(unix: number | null | undefined): string | null {
  if (!unix) return null;
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
