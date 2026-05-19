// POST /functions/v1/cred-save
// Headers: Authorization: Bearer <user JWT>
// Body: { id?, platform_name, category?, login_url?, username?, password?, notes?,
//          owner_dept_id?, tags?, is_shared_account?, active? }
//
// Create or update a vault credential. Password (if provided) is encrypted
// here on the server before insert/update so browsers never need access to
// the vault key. Update with id and omit password to leave the existing one
// in place.

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { encrypt } from "../_shared/crypto.ts";

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

  // Resolve caller's org via membership.
  const { data: mem } = await admin.from("org_members").select("org_id").eq("user_id", u.user.id).limit(1);
  if (!mem?.length) return json({ error: "no org for caller" }, 403);
  const orgId = mem[0].org_id as string;

  const id = (body.id as string | undefined) ?? null;
  const platform = (body.platform_name as string | undefined)?.trim();
  if (!id && !platform) return json({ error: "platform_name required" }, 400);

  // Build row payload. Only include password_enc if a password was provided.
  const row: Record<string, unknown> = {
    org_id: orgId,
    platform_name: platform,
    category: body.category ?? null,
    login_url: body.login_url ?? null,
    username: body.username ?? null,
    notes: body.notes ?? null,
    owner_dept_id: body.owner_dept_id ?? null,
    tags: Array.isArray(body.tags) ? body.tags : [],
    is_shared_account: body.is_shared_account ?? true,
    active: body.active ?? true,
    billing_cycle: body.billing_cycle ?? null,
    price_amount: typeof body.price_amount === "number" || (typeof body.price_amount === "string" && body.price_amount !== "")
      ? Number(body.price_amount) : null,
    price_currency: body.price_currency ?? null,
    seats_total: typeof body.seats_total === "number" || (typeof body.seats_total === "string" && body.seats_total !== "")
      ? Number(body.seats_total) : null,
    subscription_starts_at: body.subscription_starts_at ?? null,
    subscription_ends_at: body.subscription_ends_at ?? null,
    subscription_model: body.subscription_model ?? null,
    billing_api_provider: body.billing_api_provider ?? null,
  };
  if (typeof body.password === "string" && body.password.length > 0) {
    try {
      row.password_enc = await encrypt(body.password, "CRED_VAULT_ENC_KEY");
      row.last_rotated_at = new Date().toISOString();
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  if (id) {
    // Update — verify org scope first.
    const { data: existing } = await admin.from("credentials").select("org_id").eq("id", id).maybeSingle();
    if (!existing || existing.org_id !== orgId) return json({ error: "not found" }, 404);
    if (!platform) delete row.platform_name;
    const { error } = await admin.from("credentials").update(row).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id }, 200);
  } else {
    row.created_by = u.user.id;
    // Password is optional — many platforms (Slack, Notion, etc.) are OTP /
    // magic-link / SSO and have no shared password to store. Keep the row but
    // mark `is_passwordless` so the UI can show a "Login via OTP" badge.
    if (!row.password_enc) {
      row.is_passwordless = true;
    }
    const { data, error } = await admin.from("credentials").insert(row).select("id").single();
    if (error) return json({ error: error.message }, 500);

    // Per-seat pre-assignment: caller can include `assigned_employee_ids[]` to
    // mark which employees are taking up seats. We create credential_assignments
    // rows so seat-occupancy reports work; the password is NOT emailed here —
    // a separate "Send to user" action exists for that.
    if (Array.isArray(body.assigned_employee_ids) && body.assigned_employee_ids.length > 0) {
      const orgId = row.org_id as string;
      const { data: emps } = await admin.from("employees")
        .select("id, work_email, personal_email")
        .eq("org_id", orgId)
        .in("id", body.assigned_employee_ids);
      const now = new Date().toISOString();
      const assignRows = (emps ?? []).map((e: { id: string; work_email: string | null; personal_email: string | null }) => ({
        org_id: orgId,
        credential_id: data.id,
        employee_id: e.id,
        sent_at: now,
        sent_by: u.user.id,
        delivery_email: e.work_email ?? e.personal_email ?? "",
      }));
      if (assignRows.length > 0) {
        await admin.from("credential_assignments").insert(assignRows);
      }
    }

    return json({ ok: true, id: data.id }, 200);
  }
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
