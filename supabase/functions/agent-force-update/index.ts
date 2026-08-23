// POST /functions/v1/agent-force-update
//
// Admin-triggered "check for update NOW" broadcast. Wakes every agent's
// updater loop immediately instead of waiting for its next 60 s / 10 min
// poll. Same net effect as the built-in auto-update — the agent still
// downloads + verifies the signed update bundle from latest.json — just
// happens right now instead of "eventually".
//
// Body:
//   { agent_id?: uuid, org_id?: uuid }
// If `agent_id` given, sends one broadcast. Otherwise fans out to all
// active agents in the caller's org (or org_id, if super-admin service-
// role bearer).
//
// Auth: user JWT (owner/admin of the target org) or service-role.
//
// Note: only agents on v0.6.24+ have the `agent.update_now` realtime
// handler. Older agents silently ignore the event and continue on their
// normal poll cadence. The endpoint still returns success — a broadcast
// with no listeners isn't an error.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsFor } from "../_shared/cors.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;

interface Body {
  agent_id?: string;
  org_id?: string;
}

const json = (body: unknown, status = 200, cors: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405, cors);

  const authHeader = req.headers.get("authorization") ?? "";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isServiceRole = authHeader.replace(/^Bearer\s+/i, "") === SERVICE_ROLE_KEY;

  let body: Body;
  try { body = await req.json() as Body; }
  catch { body = {}; } // empty body allowed → org-wide fan-out via JWT

  // Resolve target org.
  let orgId: string | null = null;
  if (isServiceRole) {
    if (!body.org_id && !body.agent_id) {
      return json({ error: "service-role must provide org_id or agent_id" }, 400, cors);
    }
    orgId = body.org_id ?? null;
  } else {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return json({ error: "invalid token" }, 401, cors);

    // Find the caller's owner/admin org. If body.org_id was passed,
    // verify membership there.
    if (body.org_id) {
      const { data: mem } = await admin
        .from("org_members")
        .select("role")
        .eq("user_id", u.user.id)
        .eq("org_id", body.org_id)
        .in("role", ["owner", "admin"])
        .maybeSingle();
      if (!mem) return json({ error: "must be owner/admin of this org" }, 403, cors);
      orgId = body.org_id;
    } else if (body.agent_id) {
      const { data: agent } = await admin
        .from("agents").select("org_id").eq("id", body.agent_id).maybeSingle();
      if (!agent) return json({ error: "agent not found" }, 404, cors);
      const { data: mem } = await admin
        .from("org_members")
        .select("role")
        .eq("user_id", u.user.id)
        .eq("org_id", agent.org_id)
        .in("role", ["owner", "admin"])
        .maybeSingle();
      if (!mem) return json({ error: "must be owner/admin of this org" }, 403, cors);
      orgId = agent.org_id;
    } else {
      // No agent_id + no org_id → pick the caller's owner/admin org.
      const { data: mem } = await admin
        .from("org_members")
        .select("org_id")
        .eq("user_id", u.user.id)
        .in("role", ["owner", "admin"])
        .limit(1)
        .maybeSingle();
      if (!mem) return json({ error: "no owner/admin org found for caller" }, 403, cors);
      orgId = mem.org_id;
    }
  }

  // Resolve target agent list.
  let agentIds: string[] = [];
  if (body.agent_id) {
    agentIds = [body.agent_id];
  } else {
    const { data } = await admin
      .from("agents")
      .select("id")
      .eq("org_id", orgId!);
    agentIds = (data ?? []).map((a) => a.id as string);
  }

  if (agentIds.length === 0) {
    return json({ notified: 0, note: "no agents to notify" }, 200, cors);
  }

  // Fan out realtime broadcasts. Same pattern as signatures-push.
  // Concurrency-bounded loop so a 1000-agent org doesn't hammer the
  // realtime server all at once.
  const BATCH = 20;
  let notified = 0;
  for (let i = 0; i < agentIds.length; i += BATCH) {
    const slice = agentIds.slice(i, i + BATCH);
    await Promise.all(slice.map(async (id) => {
      try {
        const ch = admin.channel(`agent:${id}`);
        await ch.send({
          type: "broadcast",
          event: "agent.update_now",
          payload: { at: new Date().toISOString() },
        });
        await admin.removeChannel(ch);
        notified += 1;
      } catch (e) {
        console.warn(`[agent-force-update] broadcast to ${id} failed: ${(e as Error).message}`);
      }
    }));
  }

  return json({ notified, total: agentIds.length }, 200, cors);
});
