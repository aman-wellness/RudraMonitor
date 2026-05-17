// POST /functions/v1/group-membership-mutate
// Headers: Authorization: Bearer <user JWT>
// Body: {
//   ops: Array<{
//     group_id: string,            // directory_groups.id (our internal uuid)
//     user_id: string,             // directory_users.id  (our internal uuid)
//     action: 'add' | 'remove',
//     role?: 'member' | 'owner',   // default 'member'
//   }>
// }
//
// Best-effort: each op runs independently; we return a parallel array of
// {ok, error?} so a partial failure (e.g. one stale group_id) doesn't block
// the others. On every successful op we also update the local mirror so the
// UI reflects truth without waiting for the next directory-sync.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { graphFetch } from "../_shared/graph.ts";
import { googleJson } from "../_shared/google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface Op { group_id: string; user_id: string; action: "add" | "remove"; role?: "member" | "owner" }

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

  let body: { ops?: Op[] };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (!ops.length) return json({ error: "ops required" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve caller's org. (Member of the org is sufficient — directory mutations
  // don't strictly need owner; if you want owner-only, switch this to the owner
  // gate used elsewhere.)
  const { data: memberships } = await admin.from("org_members").select("org_id").eq("user_id", u.user.id);
  const orgIds = new Set((memberships ?? []).map((m) => m.org_id as string));
  if (!orgIds.size) return json({ error: "no org for caller" }, 403);

  // Load every group + user referenced in this batch in one shot.
  const groupIds = [...new Set(ops.map((o) => o.group_id))];
  const userIds = [...new Set(ops.map((o) => o.user_id))];
  const { data: groups } = await admin
    .from("directory_groups")
    .select("id, org_id, provider, external_id, group_type, display_name")
    .in("id", groupIds);
  const { data: users } = await admin
    .from("directory_users")
    .select("id, org_id, provider, external_id, upn")
    .in("id", userIds);
  const groupMap = new Map((groups ?? []).map((g) => [g.id, g]));
  const userMap = new Map((users ?? []).map((u) => [u.id, u]));

  const results: Array<{ index: number; ok: boolean; error?: string }> = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const grp = groupMap.get(op.group_id);
    const usr = userMap.get(op.user_id);
    const role = op.role ?? "member";
    if (!grp || !usr) { results.push({ index: i, ok: false, error: "group or user not found" }); continue; }
    if (!orgIds.has(grp.org_id as string) || grp.org_id !== usr.org_id) {
      results.push({ index: i, ok: false, error: "cross-org or unauthorised" }); continue;
    }
    if (grp.provider !== usr.provider) {
      results.push({ index: i, ok: false, error: "provider mismatch (M365 user cannot be added to a Google group)" }); continue;
    }
    if (!["add", "remove"].includes(op.action) || !["member", "owner"].includes(role)) {
      results.push({ index: i, ok: false, error: "invalid action/role" }); continue;
    }

    try {
      if (grp.provider === "m365") {
        await m365GroupMutate(grp.org_id as string, grp.external_id as string, usr.external_id as string, op.action, role);
      } else {
        await googleGroupMutate(grp.org_id as string, grp.external_id as string, usr.upn as string | null, op.action, role);
      }

      // Mirror update — keep UI in sync without waiting for next sync run.
      if (op.action === "add") {
        await admin.from("directory_group_members").upsert(
          { org_id: grp.org_id, group_id: grp.id, external_user_id: usr.external_id, role },
          { onConflict: "group_id,external_user_id,role" },
        );
      } else {
        await admin.from("directory_group_members").delete()
          .eq("group_id", grp.id).eq("external_user_id", usr.external_id).eq("role", role);
      }
      results.push({ index: i, ok: true });
    } catch (e) {
      const raw = (e as Error).message;
      // Hint when the failure is from a synced / dynamic / role-protected
      // group — these are not actually permission problems on our app, the
      // group simply isn't writable via Graph.
      let friendly = raw;
      if (/Authorization_RequestDenied|Insufficient privileges/i.test(raw)) {
        friendly = `${grp.display_name ?? grp.external_id}: cannot modify — likely synced from on-prem AD, has dynamic membership, or is role-assigned. ${raw}`;
      }
      results.push({ index: i, ok: false, error: friendly });
    }
  }

  // Refresh counts on every affected group.
  for (const gid of [...new Set(ops.map((o) => o.group_id))]) {
    const { data: cm } = await admin
      .from("directory_group_members")
      .select("role", { count: "exact" })
      .eq("group_id", gid);
    const members = (cm ?? []).filter((r) => r.role === "member").length;
    const owners  = (cm ?? []).filter((r) => r.role === "owner").length;
    await admin.from("directory_groups").update({ members_count: members, owners_count: owners, synced_at: new Date().toISOString() }).eq("id", gid);
  }

  return json({ results }, 200);
});

// ---- M365 group membership ----

async function m365GroupMutate(orgId: string, groupExtId: string, userExtId: string, action: "add" | "remove", role: "member" | "owner"): Promise<void> {
  const refPath = role === "owner" ? "owners" : "members";
  if (action === "add") {
    const r = await graphFetch(orgId, {
      method: "POST",
      path: `/groups/${groupExtId}/${refPath}/$ref`,
      body: { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${userExtId}` },
    });
    if (!r.ok && r.status !== 204) {
      const txt = await r.text();
      // "already exists" is idempotent-OK
      if (!/already exist/i.test(txt)) throw new Error(`graph add: ${r.status} ${txt}`);
    }
  } else {
    const r = await graphFetch(orgId, {
      method: "DELETE",
      path: `/groups/${groupExtId}/${refPath}/${userExtId}/$ref`,
    });
    if (!r.ok && r.status !== 204 && r.status !== 404) {
      throw new Error(`graph remove: ${r.status} ${await r.text()}`);
    }
  }
}

// ---- Google group membership ----

async function googleGroupMutate(orgId: string, groupKey: string, userEmail: string | null, action: "add" | "remove", role: "member" | "owner"): Promise<void> {
  if (!userEmail) throw new Error("user has no primaryEmail");
  if (action === "add") {
    await googleJson(orgId, {
      method: "POST",
      path: `/groups/${groupKey}/members`,
      body: { email: userEmail, role: role.toUpperCase() },
    });
  } else {
    await googleJson(orgId, {
      method: "DELETE",
      path: `/groups/${groupKey}/members/${encodeURIComponent(userEmail)}`,
    });
  }
}

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
