// GET /functions/v1/agent-settings
// Headers: Authorization: Bearer <enroll_token>  (or X-Agent-Token)
// Returns the agent's current capture settings so it can self-update its loops without an
// agent-side dashboard.
//
// IMPORTANT: settings returned here are the *effective* settings — i.e. the
// per-agent toggles in `agents` AND'd against the org's plan entitlements
// (org_effective_features). An agent on a Starter plan never gets a
// screenshots_enabled=true response, regardless of what an admin clicked,
// because Starter doesn't include screenshots. This prevents an
// over-permissive admin row from letting a Starter agent burn the
// customer's storage on screenshots they haven't paid for.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xAgent = req.headers.get("x-agent-token")?.trim() ?? "";
  const token = xAgent || bearer;
  if (!token) return json({ error: "missing agent token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin
    .from("agents")
    .select("org_id, screenshots_enabled, active_window_enabled, screenshot_interval_secs, idle_threshold_secs, videos_enabled, video_interval_secs, dlp_enabled")
    .eq("enroll_token", token)
    .maybeSingle();
  if (error) {
    console.error("agent-settings lookup:", error);
    return json({ error: "internal error" }, 500);
  }
  if (!data) return json({ error: "invalid token" }, 401);

  // Org-level entitlements via the new RPC. Returns an array of feature
  // codes (e.g. ["monitoring_basic","screenshots","videos","live","remote","dlp"]).
  // Trial / not-yet-paid orgs are handled inside the RPC the same way the
  // dashboard's useFeatures hook does.
  const { data: features } = await admin.rpc("org_effective_features", { p_org_id: data.org_id });
  const featureSet = new Set<string>((features as string[]) ?? []);

  // Defensive intersection: agent gets capability X iff
  //   the per-agent toggle is on AND the org's plan includes X.
  // Activity-log polling (monitoring_basic) gates `active_window_enabled`.
  // Idle detection is part of monitoring_basic too.
  const allowMonitoringBasic = featureSet.has("monitoring_basic");
  const allowScreenshots = featureSet.has("screenshots");
  const allowVideos = featureSet.has("videos");
  const allowDlp = featureSet.has("dlp");

  return json({
    active_window_enabled: !!data.active_window_enabled && allowMonitoringBasic,
    idle_threshold_secs: data.idle_threshold_secs,
    screenshots_enabled: !!data.screenshots_enabled && allowScreenshots,
    screenshot_interval_secs: data.screenshot_interval_secs,
    videos_enabled: !!data.videos_enabled && allowVideos,
    video_interval_secs: data.video_interval_secs,
    dlp_enabled: !!data.dlp_enabled && allowDlp,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
