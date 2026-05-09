// GET /functions/v1/agent-settings
// Headers: Authorization: Bearer <enroll_token>  (or X-Agent-Token)
// Returns the agent's current capture settings so it can self-update its loops without an
// agent-side dashboard.

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
    .select("screenshots_enabled, active_window_enabled, screenshot_interval_secs, idle_threshold_secs, videos_enabled, video_interval_secs, dlp_enabled")
    .eq("enroll_token", token)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "invalid token" }, 401);

  return json(data);
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
