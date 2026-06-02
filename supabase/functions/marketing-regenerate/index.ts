// POST /functions/v1/marketing-regenerate
// Body: { draft_id: uuid, style?: string }
//
// Marks the draft as `regen_requested` so the EC2 generator picks it up
// on its next tick. Optional `style` overrides the daemon's normal
// rotation pick — the daemon reads `requested_style` from the row when
// processing the regen, so the admin can ask for a different template
// without editing the cron schedule.
//
// Pipeline:
//   1. flip status to regen_requested
//   2. set scheduled_for = NULL so the daily idempotency check passes
//   3. persist requested_style (or NULL to clear) so the daemon's
//      pick_style() honors it
//   4. EC2 marketing-queue.timer (every 60s) calls generate.py which
//      claim_pending_regen()s the row and re-runs.
//
// We cap requested_style to a safe charset to avoid SQL/log injection on
// the daemon side; the daemon also validates the value against its
// in-code STYLE_LIBRARY and falls back to rotation if unknown.

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

  let body: { draft_id?: string; style?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.draft_id) return json({ error: "draft_id required" }, 400);

  // Style override is optional. Allow only [a-z0-9-] (matches the
  // STYLE_LIBRARY keys) to avoid passing untrusted text to the daemon.
  // Unknown styles still safe — the daemon validates against its own
  // library and falls back to rotation pick when the override is bogus.
  let requestedStyle: string | null = null;
  if (typeof body.style === "string" && body.style.trim()) {
    const s = body.style.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(s)) {
      return json({ error: "style must be lowercase letters/digits/hyphens, ≤64 chars" }, 400);
    }
    requestedStyle = s;
  }

  const { error } = await admin
    .from("marketing_drafts")
    .update({
      status: "regen_requested",
      scheduled_for: null,
      requested_style: requestedStyle,
    })
    .eq("id", body.draft_id);
  if (error) {
    console.error("marketing-regenerate:", error);
    return json({ error: "internal error" }, 500);
  }
  return json({ ok: true, requested_style: requestedStyle });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
