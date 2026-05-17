// POST /functions/v1/invoice-save
// Headers: Authorization: Bearer <user JWT>
// Body: { id?, credential_id, invoice_number?, issue_date?, period_start?,
//         period_end?, due_date?, amount?, currency?, status?, pdf_url?, notes? }
//
// Create or update one invoice for a credential. Used by the manual "Add
// invoice" form. CSV imports go through invoice-bulk-import.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const jwt = bearer(req);
  if (!jwt) return json({ error: "missing user token" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const id = (body.id as string | undefined) ?? null;
  const credId = (body.credential_id as string | undefined)?.trim();
  if (!id && !credId) return json({ error: "credential_id required" }, 400);

  // Verify the credential lives in caller's org.
  let orgId: string | null = null;
  if (credId) {
    const { data: cred } = await admin.from("credentials").select("id, org_id").eq("id", credId).maybeSingle();
    if (!cred) return json({ error: "credential not found" }, 404);
    orgId = cred.org_id;
  } else {
    const { data: existing } = await admin.from("credential_invoices").select("id, org_id").eq("id", id).maybeSingle();
    if (!existing) return json({ error: "invoice not found" }, 404);
    orgId = existing.org_id;
  }
  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", u.user.id).eq("org_id", orgId!);
  if (!mem?.length) return json({ error: "not authorised for this org" }, 403);

  const row: Record<string, unknown> = {
    invoice_number: body.invoice_number ?? null,
    issue_date: body.issue_date ?? null,
    period_start: body.period_start ?? null,
    period_end: body.period_end ?? null,
    due_date: body.due_date ?? null,
    amount: numOrNull(body.amount),
    currency: body.currency ?? null,
    status: body.status ?? "pending",
    pdf_url: body.pdf_url ?? null,
    notes: body.notes ?? null,
  };

  if (id) {
    const { error } = await admin.from("credential_invoices").update(row).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id }, 200);
  } else {
    row.org_id = orgId;
    row.credential_id = credId;
    row.source = "manual";
    row.created_by = u.user.id;
    const { data, error } = await admin.from("credential_invoices").insert(row).select("id").single();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data.id }, 200);
  }
});

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
