// POST /functions/v1/gov-seed-defaults
// Body: {} (caller's org auto-resolved)
//
// Calls gov_seed_default_pillars(p_org_id) which inserts the 9 default pillars
// + 8 default policies. Idempotent — skips if either table already has rows
// for this org. Used by the "Seed defaults" CTA on first visit to /governance.

import { corsHeaders } from "../_shared/cors.ts";
import { authzWriter, jsonResponse, logAudit } from "../_shared/gov-helpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const r = await authzWriter(req);
  if (r instanceof Response) return r;
  const { admin, orgId } = r;

  const { data, error } = await admin.rpc("gov_seed_default_pillars", { p_org_id: orgId });
  if (error) return jsonResponse({ error: error.message }, 500);

  await logAudit(admin, orgId, "system", null, "seed", (data as Record<string, unknown>) ?? {});
  return jsonResponse({ ok: true, result: data });
});
