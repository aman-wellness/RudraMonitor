// GET /functions/v1/invoice-otp-status?id=<request_id>
// Headers: Authorization: Bearer <SERVICE_ROLE_KEY>
//
// Worker polls this every ~2 s after invoice-otp-request to pick up the
// admin's OTP response. Returns the fulfilled code or 'pending' / 'expired'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ") || auth.slice(7).trim() !== SERVICE_ROLE_KEY) {
    return json({ error: "service role required" }, 401);
  }

  const url = new URL(req.url);
  const id = (url.searchParams.get("id") ?? "").trim();
  if (!id) return json({ error: "id required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await admin.rpc("otp_requests_expire_stale").catch(() => null);

  const { data: r } = await admin
    .from("otp_requests")
    .select("status, response, responded_via, expires_at")
    .eq("id", id)
    .maybeSingle();
  if (!r) return json({ error: "not found" }, 404);

  return json({
    status: r.status,
    code: r.status === "fulfilled" ? r.response : null,
    via: r.responded_via,
    expires_at: r.expires_at,
  }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
