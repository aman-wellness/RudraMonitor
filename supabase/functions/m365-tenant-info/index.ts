// POST /functions/v1/m365-tenant-info
// Headers: Authorization: Bearer <user JWT>
//
// Returns the data the "Add M365 user" wizard needs to populate its form:
//   • verified_domains:   [{ name, isDefault }]
//   • subscribed_skus:    [{ sku_id, sku_part_number, consumed, enabled, available, display_name }]
//
// We compute `available` as enabled - consumed; if negative we clamp to 0.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { graphJson } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Friendly names for the common SKUs so the UI doesn't show only the
// somewhat-cryptic skuPartNumber. Anything not in this map falls back to the
// skuPartNumber itself.
const SKU_FRIENDLY: Record<string, string> = {
  "O365_BUSINESS_ESSENTIALS": "Microsoft 365 Business Basic",
  "O365_BUSINESS_PREMIUM":    "Microsoft 365 Business Standard",
  "SPB":                      "Microsoft 365 Business Premium",
  "ENTERPRISEPACK":           "Microsoft 365 E3",
  "ENTERPRISEPREMIUM":        "Microsoft 365 E5",
  "EXCHANGESTANDARD":         "Exchange Online (Plan 1)",
  "EXCHANGEENTERPRISE":       "Exchange Online (Plan 2)",
  "FLOW_FREE":                "Microsoft Power Automate Free",
  "POWER_BI_STANDARD":        "Power BI (free)",
  "TEAMS_EXPLORATORY":        "Microsoft Teams Exploratory",
  "Microsoft_365_Copilot":    "Microsoft 365 Copilot",
};

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

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { resolveWriterOrgId } = await import("../_shared/auth-org.ts");
  const orgId = await resolveWriterOrgId(admin, u.user.id);
  if (!orgId) return json({ error: "no org for caller" }, 403);

  try {
    const [domainsResp, skusResp] = await Promise.all([
      // Graph returns domain rows where the domain string lives in `id`
      // (not `name`). Map it to `name` so the rest of the code reads cleanly.
      graphJson<{ value: Array<{ id: string; isDefault: boolean; isVerified: boolean }> }>(orgId, {
        path: "/domains?$select=id,isDefault,isVerified",
      }),
      graphJson<{ value: Array<{ skuId: string; skuPartNumber: string; consumedUnits: number; prepaidUnits: { enabled: number } }> }>(orgId, {
        path: "/subscribedSkus",
      }),
    ]);

    const verified_domains = (domainsResp.value ?? [])
      .filter((d) => d.isVerified && d.id)
      .map((d) => ({ name: d.id, isDefault: !!d.isDefault }))
      .sort((a, b) => (a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : (a.isDefault ? -1 : 1)));

    const subscribed_skus = (skusResp.value ?? []).map((s) => {
      const enabled = s.prepaidUnits?.enabled ?? 0;
      const consumed = s.consumedUnits ?? 0;
      const available = Math.max(0, enabled - consumed);
      return {
        sku_id: s.skuId,
        sku_part_number: s.skuPartNumber,
        consumed, enabled, available,
        display_name: SKU_FRIENDLY[s.skuPartNumber] ?? s.skuPartNumber,
      };
    }).sort((a, b) => a.display_name.localeCompare(b.display_name));

    return json({ verified_domains, subscribed_skus }, 200);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
