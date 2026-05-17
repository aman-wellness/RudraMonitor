// POST /functions/v1/asset-save
// Headers: Authorization: Bearer <user JWT>
// Body: { id?, device_serial, device_tag?, device_type?, configuration?, ram_gb?,
//         disk_gb?, brand?, model?, purchase_price?, purchase_currency?,
//         purchase_date?, notes?, status? }
//
// Create-or-update an inventory row. device_serial is the unique key per org.
// Assignment is handled separately by /asset-assign — this fn doesn't touch
// assigned_employee_id so admins can't accidentally re-route a device by
// editing metadata.

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

  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", u.user.id).limit(1);
  if (!mem?.length) return json({ error: "no org for caller" }, 403);
  const orgId = mem[0].org_id as string;

  const id = (body.id as string | undefined) ?? null;
  const serial = (body.device_serial as string | undefined)?.trim();
  if (!id && !serial) return json({ error: "device_serial required" }, 400);

  const row: Record<string, unknown> = {
    org_id: orgId,
    device_serial: serial,
    device_tag: body.device_tag ?? null,
    device_type: body.device_type ?? "laptop",
    configuration: body.configuration ?? null,
    ram_gb: numOrNull(body.ram_gb),
    disk_gb: numOrNull(body.disk_gb),
    brand: body.brand ?? null,
    model: body.model ?? null,
    purchase_price: numOrNull(body.purchase_price),
    purchase_currency: body.purchase_currency ?? null,
    purchase_date: body.purchase_date ?? null,
    notes: body.notes ?? null,
    status: body.status ?? "in_stock",
  };

  if (id) {
    const { data: existing } = await admin.from("hardware_assets").select("org_id").eq("id", id).maybeSingle();
    if (!existing || existing.org_id !== orgId) return json({ error: "asset not found" }, 404);
    if (!serial) delete row.device_serial;
    const { error } = await admin.from("hardware_assets").update(row).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id }, 200);
  } else {
    row.created_by = u.user.id;
    const { data, error } = await admin.from("hardware_assets").insert(row).select("id").single();
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
