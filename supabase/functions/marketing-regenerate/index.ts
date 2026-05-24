// POST /functions/v1/marketing-regenerate
// Body: { draft_id: uuid }
//
// Marks the draft as `regen_requested` AND triggers a fresh generation
// on the EC2 host out-of-band. The host has a `rudrans-marketing@.service`
// systemd template; we ask systemd-run via a tiny SSH shim to start a
// `regen-<draft_id>` instance. But we don't actually SSH from inside an
// edge function (no key material here), so the cleanest path is:
//   1. flip status to regen_requested
//   2. set scheduled_for to NULL so it doesn't conflict with the daily
//      idempotency check
//   3. rely on the EC2 host's marketing-queue.timer (fires every 60s)
//      to pick up regen_requested rows and re-run the pipeline
//
// The queue timer is added in a follow-up commit; until then, regenerate
// just marks the row + super-admin SSHs in to manually trigger.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) return json({ error: "unauthenticated" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userRes } = await admin.auth.getUser(bearer);
  const uid = userRes?.user?.id;
  if (!uid) return json({ error: "unauthenticated" }, 401);

  const { data: superRow } = await admin.rpc("is_super_admin");
  if (!superRow) return json({ error: "super admin required" }, 403);

  let body: { draft_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.draft_id) return json({ error: "draft_id required" }, 400);

  // Flip status + clear scheduled_for so the daily idempotency check
  // doesn't block the regen. Generator script picks up regen_requested
  // rows on its next tick.
  const { error } = await admin
    .from("marketing_drafts")
    .update({ status: "regen_requested", scheduled_for: null })
    .eq("id", body.draft_id);
  if (error) {
    console.error("marketing-regenerate:", error);
    return json({ error: "internal error" }, 500);
  }
  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
