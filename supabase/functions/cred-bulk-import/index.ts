// POST /functions/v1/cred-bulk-import
// Headers: Authorization: Bearer <user JWT>
// Body: { rows: Array<{
//   platform_name, password, category?, login_url?, username?, notes?, tags?,
//   billing_cycle?, price_amount?, price_currency?, seats_total?,
//   subscription_starts_at?, subscription_ends_at?, owner_department?,
//   is_shared_account?, active?,
// }> }
//
// Each row is encrypted and inserted independently — partial failures don't
// block the rest. Returns a per-row outcome array so the UI can render a
// success/failure summary. `owner_department` is resolved to an id by name
// for convenience when importing from a spreadsheet.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { encrypt } from "../_shared/crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface InRow {
  platform_name?: string;
  password?: string;
  category?: string | null;
  login_url?: string | null;
  username?: string | null;
  notes?: string | null;
  tags?: string[] | string | null;
  billing_cycle?: string | null;
  price_amount?: number | string | null;
  price_currency?: string | null;
  seats_total?: number | string | null;
  subscription_starts_at?: string | null;
  subscription_ends_at?: string | null;
  owner_department?: string | null;
  is_shared_account?: boolean | string;
  active?: boolean | string;
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
  if (rows.length > 500) return json({ error: "max 500 rows per import" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Bulk-importing shared vault credentials is an owner/admin action (audit
  // M17) — same gate as cred-save/cred-delete.
  const { data: mem } = await admin.from("org_members").select("org_id, role").eq("user_id", u.user.id).limit(1);
  if (!mem?.length) return json({ error: "no org for caller" }, 403);
  if (!["owner", "admin"].includes(String(mem[0].role ?? ""))) {
    return json({ error: "owner or admin role required" }, 403);
  }
  const orgId = mem[0].org_id as string;

  // Pre-fetch departments so we can resolve names to ids (CSV writers won't
  // know our internal uuids).
  const { data: depts } = await admin.from("org_departments").select("id, name").eq("org_id", orgId);
  const deptIdByName = new Map<string, string>(
    (depts ?? []).map((d: { id: string; name: string }) => [d.name.toLowerCase(), d.id]),
  );

  const outcomes: Array<{ index: number; ok: boolean; id?: string; error?: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const platform = (r.platform_name ?? "").trim();
      const password = (r.password ?? "").trim();
      if (!platform) throw new Error("platform_name required");
      if (!password) throw new Error("password required");

      const tags = Array.isArray(r.tags)
        ? r.tags
        : typeof r.tags === "string"
          ? r.tags.split(/[,;|]/).map((s) => s.trim()).filter(Boolean)
          : [];

      const ownerDept = r.owner_department
        ? deptIdByName.get(r.owner_department.toLowerCase()) ?? null
        : null;

      const password_enc = await encrypt(password, "CRED_VAULT_ENC_KEY");

      const { data, error } = await admin.from("credentials").insert({
        org_id: orgId,
        platform_name: platform,
        category: r.category ?? null,
        login_url: r.login_url ?? null,
        username: r.username ?? null,
        password_enc,
        notes: r.notes ?? null,
        owner_dept_id: ownerDept,
        tags,
        is_shared_account: parseBool(r.is_shared_account, true),
        active: parseBool(r.active, true),
        billing_cycle: r.billing_cycle ?? null,
        price_amount: numOrNull(r.price_amount),
        price_currency: r.price_currency ?? null,
        seats_total: numOrNull(r.seats_total) ?? null,
        subscription_starts_at: r.subscription_starts_at ?? null,
        subscription_ends_at: r.subscription_ends_at ?? null,
        created_by: u.user.id,
        last_rotated_at: new Date().toISOString(),
      }).select("id").single();
      if (error) throw new Error(error.message);
      outcomes.push({ index: i, ok: true, id: data.id });
    } catch (e) {
      outcomes.push({ index: i, ok: false, error: (e as Error).message });
    }
  }

  const ok = outcomes.filter((o) => o.ok).length;
  return json({ imported: ok, failed: rows.length - ok, outcomes }, 200);
});

function parseBool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === "") return dflt;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return ["1", "true", "yes", "y", "t"].includes(s);
}
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
