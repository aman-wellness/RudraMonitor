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
    .select("org_id, screenshots_enabled, active_window_enabled, screenshot_interval_secs, idle_threshold_secs, videos_enabled, video_interval_secs, dlp_enabled, removable_disks_blocked, wallpaper_enforced, tracking_schedule_override, tracking_schedule_json")
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

  // Org-wide wallpaper + tracking schedule settings. NULL row = nothing
  // configured for this org yet. maybeSingle so first-ever fetch (before
  // any admin opens org settings) doesn't fail.
  const { data: orgSettings } = await admin
    .from("organization_settings")
    .select("wallpaper_url, wallpaper_updated_at, tracking_schedule_enabled, tracking_schedule_json")
    .eq("org_id", data.org_id)
    .maybeSingle();

  // Email DLP MITM opt-in (migration 0148 / 0149). Only surfaces true
  // when: (a) the org has explicitly flipped the flag in Settings, AND
  // (b) their plan includes DLP. Both agent and edge fn re-check the
  // plan here so a lapsed subscription silently turns the proxy off
  // without touching the row.
  const { data: dlpSettings } = await admin
    .from("dlp_settings")
    .select("email_intercept_public_only, email_body_capture")
    .eq("org_id", data.org_id)
    .maybeSingle();

  // Tracking schedule resolution: per-agent override beats org default.
  //
  //   If the agent has tracking_schedule_override = true → use the agent's
  //   own schedule JSON (may be NULL → no schedule = 24/7 tracking).
  //   Otherwise → fall back to the org default. If org schedule is
  //   disabled or NULL, the agent tracks 24/7.
  let trackingScheduleEnabled = false;
  let trackingScheduleJson: string | null = null;
  if (data.tracking_schedule_override) {
    trackingScheduleEnabled = !!data.tracking_schedule_json;
    trackingScheduleJson = (data.tracking_schedule_json as string | null) ?? null;
  } else if (orgSettings?.tracking_schedule_enabled) {
    trackingScheduleEnabled = true;
    trackingScheduleJson = (orgSettings.tracking_schedule_json as string | null) ?? null;
  }

  return json({
    active_window_enabled: !!data.active_window_enabled && allowMonitoringBasic,
    idle_threshold_secs: data.idle_threshold_secs,
    screenshots_enabled: !!data.screenshots_enabled && allowScreenshots,
    screenshot_interval_secs: data.screenshot_interval_secs,
    videos_enabled: !!data.videos_enabled && allowVideos,
    video_interval_secs: data.video_interval_secs,
    dlp_enabled: !!data.dlp_enabled && allowDlp,
    // USB block + wallpaper: not gated by plan features for v1 (free for all
    // tiers). If product later wants to paywall these, intersect with feature
    // codes here the same way as screenshots/videos above.
    removable_disks_blocked: !!data.removable_disks_blocked,
    wallpaper_enforced: !!data.wallpaper_enforced,
    wallpaper_url: orgSettings?.wallpaper_url ?? null,
    wallpaper_updated_at: orgSettings?.wallpaper_updated_at ?? null,
    tracking_schedule_enabled: trackingScheduleEnabled,
    tracking_schedule_json: trackingScheduleJson,
    // Email DLP MITM proxy — only fires when the plan includes DLP AND
    // the admin has explicitly opted in in Settings. Default off
    // post-0149 so a v0.7.0 rollout doesn't start intercepting HTTPS
    // for anyone who hasn't asked for it.
    email_intercept_public_only:
      allowDlp && !!dlpSettings?.email_intercept_public_only,
    email_body_capture: dlpSettings?.email_body_capture ?? true,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
