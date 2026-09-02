// POST /functions/v1/agent-inventory-refresh
// Body: { agent_id: string }
// Auth: user JWT (dashboard admin).
//
// Fires an `inventory.refresh` broadcast on the target agent's Realtime
// channel. Agent picks up the event in remote/realtime_listener.rs and
// runs inventory::one_cycle immediately, bypassing the 24 h scheduled
// cadence. Fire-and-forget — the response returns as soon as the
// broadcast is enqueued; the fresh inventory row lands via the
// existing agent-inventory-post edge function ~5-10 s later.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!bearer) return json({ error: "missing bearer token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userRes } = await admin.auth.getUser(bearer);
  if (!userRes?.user) return json({ error: "unauthenticated" }, 401);
  const userId = userRes.user.id;

  let body: { agent_id?: string };
  try { body = await req.json(); }
  catch { return json({ error: "invalid json" }, 400); }
  const agentId = body.agent_id?.trim();
  if (!agentId) return json({ error: "agent_id required" }, 400);

  // Authorise: caller must belong to the same org as the agent.
  const { data: agent } = await admin
    .from("agents").select("id, org_id").eq("id", agentId).maybeSingle();
  if (!agent) return json({ error: "agent not found" }, 404);
  const { data: member } = await admin
    .from("org_members")
    .select("role")
    .eq("user_id", userId)
    .eq("org_id", agent.org_id)
    .maybeSingle();
  if (!member || !["owner", "admin", "super_admin"].includes(member.role)) {
    return json({ error: "not authorised for this org" }, 403);
  }

  try {
    const status = await admin.channel(`agent:${agentId}`).send({
      type: "broadcast",
      event: "inventory.refresh",
      payload: {},
    });
    return json({ ok: true, broadcast_status: status });
  } catch (e) {
    return json({ error: `broadcast failed: ${(e as Error).message}` }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
