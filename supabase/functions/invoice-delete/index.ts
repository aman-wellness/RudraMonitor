// POST /functions/v1/invoice-delete
// Headers: Authorization: Bearer <user JWT>
// Body:
//   { ids: uuid[] }                                    — bulk by id
//   { date_from: 'YYYY-MM-DD', date_to: 'YYYY-MM-DD',  — date range
//     credential_id?: uuid }                             (opt scope)
//
// Deletes credential_invoices rows AND their attached storage files
// for invoices that belong to the caller's org. Why an edge function:
//   • Client can hit RLS for DELETE but not for storage.remove() of
//     each attachment_path in a single transaction — we'd leak files.
//   • Date-range deletion takes one query instead of N round-trips.
//   • Same audit pattern as cred-delete (one place to extend later).

import { corsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

type Body = {
  ids?: string[];
  date_from?: string;
  date_to?: string;
  credential_id?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing user token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: userErr } = await userClient.auth.getUser();
  if (userErr || !u.user) return json({ error: "invalid token" }, 401);
  const uid = u.user.id;

  let body: Body;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Caller's orgs — every row we delete must belong to one of these.
  const { data: orgs, error: orgsErr } = await admin
    .from("org_members")
    .select("org_id")
    .eq("user_id", uid);
  if (orgsErr) return json({ error: orgsErr.message }, 500);
  const orgIds = (orgs ?? []).map((r: { org_id: string }) => r.org_id);
  if (orgIds.length === 0) return json({ error: "no org" }, 403);

  // Build the query that selects rows in scope. We need id +
  // attachment_path so we can remove storage objects after the row
  // delete.
  let q = admin
    .from("credential_invoices")
    .select("id, attachment_path")
    .in("org_id", orgIds);

  if (Array.isArray(body.ids) && body.ids.length > 0) {
    q = q.in("id", body.ids);
  } else if (body.date_from || body.date_to) {
    // Date-range mode. issue_date is the user-facing "invoice date"
    // (matches what the dashboard filter ranges over). Either bound is
    // optional → open-ended range.
    if (body.date_from) q = q.gte("issue_date", body.date_from);
    if (body.date_to)   q = q.lte("issue_date", body.date_to);
    if (body.credential_id) q = q.eq("credential_id", body.credential_id);
  } else {
    return json({ error: "must specify ids or date range" }, 400);
  }

  const { data: targets, error: selErr } = await q;
  if (selErr) return json({ error: selErr.message }, 500);
  const list = (targets ?? []) as { id: string; attachment_path: string | null }[];
  if (list.length === 0) return json({ ok: true, deleted: 0, files_deleted: 0 });

  // Bulk-delete the rows. ON DELETE CASCADE on usage_summary etc.
  // already chains; no extra cleanup needed in SQL.
  const { error: delErr } = await admin
    .from("credential_invoices")
    .delete()
    .in("id", list.map((r) => r.id));
  if (delErr) return json({ error: delErr.message }, 500);

  // Best-effort delete of any attached files. Failure here doesn't
  // roll back the row delete (the row is gone, so the file is orphan
  // anyway — log + continue).
  const paths = list.map((r) => r.attachment_path).filter((p): p is string => !!p);
  let filesDeleted = 0;
  if (paths.length > 0) {
    const { data: rm, error: rmErr } = await admin.storage
      .from("credential-invoices")
      .remove(paths);
    if (rmErr) console.error("storage remove failed:", rmErr.message);
    else filesDeleted = rm?.length ?? 0;
  }

  return json({ ok: true, deleted: list.length, files_deleted: filesDeleted });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
