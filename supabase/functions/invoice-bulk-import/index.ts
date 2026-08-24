// POST /functions/v1/invoice-bulk-import
// Headers: Authorization: Bearer <user JWT>
// Body: { rows: Array<{ platform_name | credential_id, invoice_number?,
//   issue_date?, period_start?, period_end?, due_date?, amount?, currency?,
//   status?, pdf_url?, notes? }> }
//
// CSV uploader accepts either credential_id (uuid) or platform_name; we
// resolve the latter to a credential in the caller's org. Existing invoices
// are matched by (credential_id, invoice_number) and updated rather than
// duplicated, so a fresh export of the same month idempotently refreshes.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface InRow {
  credential_id?: string;
  platform_name?: string;
  invoice_number?: string;
  issue_date?: string;
  period_start?: string;
  period_end?: string;
  due_date?: string;
  amount?: string | number;
  currency?: string;
  status?: string;
  pdf_url?: string;
  notes?: string;
}

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

  let body: { rows?: InRow[] };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return json({ error: "rows required" }, 400);
  if (rows.length > 1000) return json({ error: "max 1000 rows per import" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", u.user.id).limit(1);
  if (!mem?.length) return json({ error: "no org for caller" }, 403);
  const orgId = mem[0].org_id as string;

  // Pre-fetch platform_name → credential_id map (one lookup, scoped to org).
  const { data: allCreds } = await admin
    .from("credentials").select("id, platform_name").eq("org_id", orgId);
  const credIdByPlatform = new Map<string, string>(
    (allCreds ?? []).map((c: { id: string; platform_name: string }) => [c.platform_name.toLowerCase(), c.id]),
  );
  // SECURITY REVIEW H2: the set of credential ids that actually belong to the
  // caller's org, so a body-supplied `credential_id` can't target another org.
  const validCredIds = new Set<string>((allCreds ?? []).map((c: { id: string }) => c.id));

  const outcomes: Array<{ index: number; ok: boolean; id?: string; action?: "insert" | "update"; error?: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const credId = r.credential_id
        ? r.credential_id.trim()
        : credIdByPlatform.get((r.platform_name ?? "").trim().toLowerCase());
      if (!credId) throw new Error(`unknown credential (platform_name='${r.platform_name ?? ""}')`);
      // Reject any credential_id that isn't in this org (cross-tenant IDOR).
      if (!validCredIds.has(credId)) throw new Error("credential does not belong to your organization");

      const payload: Record<string, unknown> = {
        org_id: orgId,
        credential_id: credId,
        invoice_number: r.invoice_number ?? null,
        issue_date: r.issue_date ?? null,
        period_start: r.period_start ?? null,
        period_end: r.period_end ?? null,
        due_date: r.due_date ?? null,
        amount: numOrNull(r.amount),
        currency: r.currency ?? null,
        status: r.status ?? "pending",
        pdf_url: r.pdf_url ?? null,
        notes: r.notes ?? null,
        source: "csv",
      };

      // Dedupe by (credential_id, invoice_number) when invoice_number is set.
      let existing: { id: string } | null = null;
      if (r.invoice_number) {
        const { data } = await admin
          .from("credential_invoices")
          .select("id")
          .eq("org_id", orgId)
          .eq("credential_id", credId)
          .eq("invoice_number", r.invoice_number)
          .maybeSingle();
        existing = (data as { id: string } | null) ?? null;
      }

      if (existing) {
        const { error } = await admin.from("credential_invoices").update(payload).eq("id", existing.id).eq("org_id", orgId);
        if (error) throw new Error(error.message);
        outcomes.push({ index: i, ok: true, id: existing.id, action: "update" });
      } else {
        payload.created_by = u.user.id;
        const { data, error } = await admin.from("credential_invoices").insert(payload).select("id").single();
        if (error) throw new Error(error.message);
        outcomes.push({ index: i, ok: true, id: data.id, action: "insert" });
      }
    } catch (e) {
      outcomes.push({ index: i, ok: false, error: (e as Error).message });
    }
  }

  const ok = outcomes.filter((o) => o.ok).length;
  return json({
    imported: outcomes.filter((o) => o.action === "insert").length,
    updated: outcomes.filter((o) => o.action === "update").length,
    failed: rows.length - ok,
    outcomes,
  }, 200);
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
