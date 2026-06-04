// POST /functions/v1/gov-channel-save
// Body: { id?, layer ('L1'|'L2'|'L3'), name, purpose?, parent_channel_id?,
//         primary_pillar_id?, sort_order?, member_employee_ids?: string[] }
//
// Saves the channel row, then (if member_employee_ids provided) replaces the
// channel's member list with that set.

import { corsHeaders } from "../_shared/cors.ts";
import { authzWriter, jsonResponse, logAudit } from "../_shared/gov-helpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const r = await authzWriter(req);
  if (r instanceof Response) return r;
  const { admin, orgId } = r;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return jsonResponse({ error: "invalid json" }, 400); }

  const id = (body.id as string | undefined) ?? null;
  const name = (body.name as string | undefined)?.trim();
  const layer = (body.layer as string | undefined) ?? "L2";
  if (!id && !name) return jsonResponse({ error: "name required" }, 400);
  if (!["L1", "L2", "L3"].includes(layer)) return jsonResponse({ error: "layer must be L1/L2/L3" }, 400);

  const row: Record<string, unknown> = {
    org_id: orgId,
    layer,
    purpose: body.purpose ?? null,
    parent_channel_id: body.parent_channel_id ?? null,
    primary_pillar_id: body.primary_pillar_id ?? null,
    sort_order: typeof body.sort_order === "number" ? body.sort_order : 100,
  };
  if (name) row.name = name.startsWith("#") ? name : `#${name}`;

  let channelId: string;
  if (id) {
    const { data, error } = await admin
      .from("gov_channels").update(row).eq("id", id).eq("org_id", orgId).select("id").single();
    if (error) return jsonResponse({ error: error.message }, 500);
    channelId = data.id;
    await logAudit(admin, orgId, "channel", id, "update", { name: row.name });
  } else {
    const { data, error } = await admin
      .from("gov_channels").insert(row).select("id").single();
    if (error) return jsonResponse({ error: error.message }, 500);
    channelId = data.id;
    await logAudit(admin, orgId, "channel", channelId, "create", { name: row.name });
  }

  // Replace member list if provided. Empty array = clear all members.
  if (Array.isArray(body.member_employee_ids)) {
    const memberIds = body.member_employee_ids as string[];
    await admin.from("gov_channel_members").delete().eq("channel_id", channelId).eq("org_id", orgId);
    if (memberIds.length > 0) {
      const memberRows = memberIds.map((eid) => ({
        org_id: orgId, channel_id: channelId, employee_id: eid, member_type: "member",
      }));
      const { error: memErr } = await admin.from("gov_channel_members").insert(memberRows);
      if (memErr) return jsonResponse({ error: `members: ${memErr.message}` }, 500);
    }
  }
  return jsonResponse({ ok: true, id: channelId });
});
