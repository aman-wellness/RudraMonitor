// POST /functions/v1/org-settings-save
// Headers: Authorization: Bearer <user JWT>
// Body: { it_recipient_emails?: string[], hr_recipient_emails?: string[], accounts_recipient_emails?: string[] }
//
// Updates the per-org default notification recipient lists used by the
// credential-request workflow (IT CC at submit, IT TO after manager approve)
// and offboarding stage 3 (HR + Accounts). Only fields actually present in
// the request body are touched.

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
  const callerId = u.user.id;

  let body: { it_recipient_emails?: string[]; hr_recipient_emails?: string[]; accounts_recipient_emails?: string[] };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Org owner OR admin can edit. We look up which org the caller is an
  // org_member of with a write role, fall back to owner_user_id lookup so
  // freshly-signed-up owners (who may not have an org_members row yet) still
  // work.
  let orgId: string | null = null;
  const { data: writerMember } = await admin
    .from("org_members")
    .select("org_id, role")
    .eq("user_id", callerId)
    .in("role", ["owner", "admin"])
    .limit(1)
    .maybeSingle();
  if (writerMember?.org_id) {
    orgId = writerMember.org_id as string;
  } else {
    const { data: ownedOrgs } = await admin.from("organizations").select("id").eq("owner_user_id", callerId).limit(1);
    if (ownedOrgs?.length) orgId = ownedOrgs[0].id as string;
  }
  if (!orgId) return json({ error: "only the org owner or an org admin can change these settings" }, 403);

  const clean = (arr: unknown): string[] | undefined => {
    if (!Array.isArray(arr)) return undefined;
    return [...new Set(arr.map((x) => String(x).trim()).filter((x) => x.includes("@")))];
  };

  const patch: Record<string, unknown> = {};
  const it = clean(body.it_recipient_emails);
  const hr = clean(body.hr_recipient_emails);
  const ac = clean(body.accounts_recipient_emails);
  if (it !== undefined) patch.it_recipient_emails = it;
  if (hr !== undefined) patch.hr_recipient_emails = hr;
  if (ac !== undefined) patch.accounts_recipient_emails = ac;

  if (Object.keys(patch).length === 0) {
    return json({ ok: true, message: "no fields to update" }, 200);
  }

  const { error } = await admin.from("organizations").update(patch).eq("id", orgId);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
