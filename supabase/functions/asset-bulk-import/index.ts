// POST /functions/v1/asset-bulk-import
// Headers: Authorization: Bearer <user JWT>
// Body: { rows: Array<asset-shape> }
//
// Per-row outcome; partial failures don't block the rest. Updates by
// device_serial if a row with that serial already exists in the org, else
// inserts. This makes the same CSV re-uploadable to refresh metadata.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface InRow {
  device_serial?: string;
  device_tag?: string;
  device_type?: string;
  configuration?: string;
  ram_gb?: string | number;
  disk_gb?: string | number;
  brand?: string;
  model?: string;
  purchase_price?: string | number;
  purchase_currency?: string;
  purchase_date?: string;
  notes?: string;
  status?: string;
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

  const outcomes: Array<{ index: number; ok: boolean; id?: string; action?: "insert" | "update"; error?: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const serial = (r.device_serial ?? "").trim();
      if (!serial) throw new Error("device_serial required");

      const payload: Record<string, unknown> = {
        org_id: orgId,
        device_serial: serial,
        device_tag: r.device_tag ?? null,
        device_type: normalizeDeviceType(r.device_type),
        configuration: r.configuration ?? null,
        ram_gb: numOrNull(r.ram_gb),
        disk_gb: numOrNull(r.disk_gb),
        brand: r.brand ?? null,
        model: r.model ?? null,
        purchase_price: numOrNull(r.purchase_price),
        purchase_currency: r.purchase_currency ?? null,
        purchase_date: r.purchase_date ?? null,
        notes: r.notes ?? null,
        status: normalizeStatus(r.status),
      };

      const { data: existing } = await admin
        .from("hardware_assets")
        .select("id")
        .eq("org_id", orgId)
        .eq("device_serial", serial)
        .maybeSingle();

      if (existing) {
        const { error } = await admin.from("hardware_assets").update(payload).eq("id", existing.id);
        if (error) throw new Error(error.message);
        outcomes.push({ index: i, ok: true, id: existing.id, action: "update" });
      } else {
        payload.created_by = u.user.id;
        const { data, error } = await admin.from("hardware_assets").insert(payload).select("id").single();
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

// Normalize the free-text "status" value from a customer's CSV to one of
// the DB check-constraint values. Anything we don't recognize falls back to
// `in_stock` so the import doesn't fail outright.
function normalizeStatus(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!s) return "in_stock";
  const map: Record<string, string> = {
    in_stock: "in_stock", instock: "in_stock", available: "in_stock",
    new: "in_stock", spare: "in_stock", stock: "in_stock", unused: "in_stock",
    ready: "in_stock", working: "in_stock", active: "in_stock",
    assigned: "assigned", inuse: "assigned", in_use: "assigned",
    allocated: "assigned", issued: "assigned", deployed: "assigned",
    given: "assigned", handover: "assigned", handed_over: "assigned",
    retired: "retired", decommissioned: "retired", scrapped: "retired",
    disposed: "retired", end_of_life: "retired", eol: "retired",
    lost: "lost", stolen: "lost", missing: "lost",
    rma: "rma", repair: "rma", under_repair: "rma", warranty: "rma",
    damaged: "rma", broken: "rma", servicing: "rma",
  };
  return map[s] ?? "in_stock";
}

// Same idea for device_type. CSV often has "Laptop", "MacBook", "iPad" etc.
function normalizeDeviceType(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "laptop";
  if (/laptop|macbook|notebook|thinkpad/.test(s)) return "laptop";
  if (/desktop|workstation|imac|pc/.test(s)) return "desktop";
  if (/monitor|display|screen/.test(s)) return "monitor";
  if (/phone|mobile|iphone|android/.test(s)) return "phone";
  if (/tablet|ipad/.test(s)) return "tablet";
  if (/keyboard|mouse|headset|webcam|dock|cable|charger|accessor/.test(s)) return "accessory";
  // Pass through if it's already one of the known enum values.
  if (["laptop","desktop","monitor","phone","tablet","accessory","other"].includes(s)) return s;
  return "other";
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
