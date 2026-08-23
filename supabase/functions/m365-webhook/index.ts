// POST/GET /functions/v1/m365-webhook
//
// Microsoft Graph Change Notifications receiver. Two protocols on this URL:
//
//   1. Subscription validation (one shot per subscription creation):
//        POST or GET with ?validationToken=…&validationtokens=…
//      → respond 200 with the raw token in text/plain within 10 seconds.
//
//   2. Notifications (every time a /users or /groups resource changes):
//        POST with JSON body {value: [{ subscriptionId, clientState,
//        changeType, resource, resourceData: {id, ...}, tenantId, ... }]}
//      → respond 202 within 30 seconds, do the actual upsert async.
//
// Resource shapes we subscribe to:
//   "users"            → user created/updated/deleted in the tenant
//   "groups"           → group created/updated/deleted (membership change
//                        on a group also surfaces here as an updated event)
//
// The resource URL on each notification looks like "Users/<guid>" or
// "Groups/<guid>"; we parse that and re-fetch the single row from Graph
// to keep directory_users / directory_groups in sync. No full walk.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { graphTokenFor } from "../_shared/graph.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH_BASE       = "https://graph.microsoft.com/v1.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // 1. Validation handshake — Microsoft echoes a validationToken as a
  // query string. We MUST return it as text/plain within 10 seconds or
  // the subscription create call will fail.
  const url  = new URL(req.url);
  const vtok = url.searchParams.get("validationToken");
  if (vtok) {
    return new Response(vtok, {
      status: 200,
      headers: { "Content-Type": "text/plain", ...corsHeaders },
    });
  }

  if (req.method !== "POST") return text("method not allowed", 405);

  let body: NotificationBody;
  try { body = await req.json(); } catch { return text("invalid json", 400); }
  if (!Array.isArray(body?.value)) return text("ok", 202); // nothing to do

  // Acknowledge the batch FIRST in case downstream work is slow — Microsoft
  // retries the whole batch if we don't 202 within 30 sec, and a retry on
  // top of an already-running upsert causes duplicate work.
  queueBackground(() => process(body.value).catch((e) => console.error("[m365-webhook] async process error:", (e as Error).message)));
  return text("", 202);
});

interface Notification {
  subscriptionId: string;
  subscriptionExpirationDateTime?: string;
  changeType: "created" | "updated" | "deleted";
  resource: string;                       // "Users/<guid>" | "Groups/<guid>"
  resourceData?: { id?: string; "@odata.id"?: string; "@odata.type"?: string };
  clientState?: string;
  tenantId?: string;
}
interface NotificationBody { value: Notification[] }

async function process(notifs: Notification[]): Promise<void> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // De-dup by (subscriptionId, resource) — Graph can deliver duplicate
  // events when several attributes flip in the same second.
  const seen = new Set<string>();
  for (const n of notifs) {
    const key = `${n.subscriptionId}|${n.resource}|${n.changeType}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Resolve the orgId by looking up which org owns this subscriptionId.
    // SECURITY (audit M21): subscriptionId comes from the request body and is
    // interpolated into a raw PostgREST .or() filter. A crafted value like
    // `x,webhook_secret.is.null` could alter the row-selection filter to match a
    // row whose clientState check is then skipped. Graph subscription ids are
    // GUIDs, so reject anything that isn't GUID-shaped before it reaches the
    // filter — commas, dots and operators (what .or() parses) can't get through.
    if (!/^[0-9a-fA-F-]{20,64}$/.test(String(n.subscriptionId ?? ""))) {
      console.warn(`[m365-webhook] rejecting malformed subscriptionId`);
      continue;
    }
    // We store BOTH subscription_id_users and subscription_id_groups on the
    // same row so a single .or() query handles either.
    const { data: orgRow } = await admin
      .from("org_integrations")
      .select("org_id, webhook_secret, subscription_id_users, subscription_id_groups")
      .eq("provider", "m365")
      .or(`subscription_id_users.eq.${n.subscriptionId},subscription_id_groups.eq.${n.subscriptionId}`)
      .maybeSingle();
    if (!orgRow) {
      console.warn(`[m365-webhook] no org owns subscription ${n.subscriptionId} — stale notification, skipping`);
      continue;
    }
    // SECURITY: must be an exact string equality on a non-empty secret. The
    // earlier form `webhook_secret && n.clientState && …` short-circuited when
    // the attacker simply omitted clientState, so any caller who guessed a
    // subscriptionId could trigger arbitrary directory re-syncs. Now: if the
    // org has a configured secret, the notification MUST present that exact
    // secret or we drop it.
    if (orgRow.webhook_secret) {
      if (!n.clientState || n.clientState !== orgRow.webhook_secret) {
        console.warn(`[m365-webhook] clientState mismatch for org ${orgRow.org_id} — possible spoof, skipping`);
        continue;
      }
    }
    const orgId = orgRow.org_id as string;

    // Audit-trail row first so retries are idempotent on resource path.
    await admin.from("directory_change_queue").insert({
      org_id: orgId, provider: "m365",
      resource: n.resource.toLowerCase(),
      change_type: n.changeType,
      status: "processing",
      attempts: 1,
    });

    try {
      await applyChange(admin, orgId, n);
      await admin.from("directory_change_queue")
        .update({ status: "done", processed_at: new Date().toISOString() })
        .eq("org_id", orgId)
        .eq("resource", n.resource.toLowerCase())
        .eq("change_type", n.changeType)
        .eq("status", "processing");
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[m365-webhook] apply ${n.resource} (${n.changeType}) for org ${orgId}: ${msg}`);
      await admin.from("directory_change_queue")
        .update({ status: "failed", last_error: msg.slice(0, 1000) })
        .eq("org_id", orgId)
        .eq("resource", n.resource.toLowerCase())
        .eq("change_type", n.changeType)
        .eq("status", "processing");
    }
  }
}

async function applyChange(
  admin: ReturnType<typeof createClient>,
  orgId: string,
  n: Notification,
): Promise<void> {
  // Resource path is case-flexible per MS docs; normalise to lowercase.
  const path = n.resource.toLowerCase();
  const m = path.match(/^(users|groups)\/([0-9a-f-]{36})/);
  if (!m) {
    console.warn(`[m365-webhook] unrecognised resource path: ${n.resource}`);
    return;
  }
  const kind = m[1];                 // "users" | "groups"
  const extId = m[2];                // GUID

  // Deletes — purge the local row. ON DELETE CASCADE on directory_group_members
  // takes care of membership rows when a group is removed.
  if (n.changeType === "deleted") {
    if (kind === "users") {
      await admin.from("directory_users")
        .delete().eq("org_id", orgId).eq("provider", "m365").eq("external_id", extId);
    } else {
      await admin.from("directory_groups")
        .delete().eq("org_id", orgId).eq("provider", "m365").eq("external_id", extId);
    }
    return;
  }

  // Created / updated — fetch the canonical row from Graph + upsert.
  const { accessToken } = await graphTokenFor(orgId);

  if (kind === "users") {
    // Pull every "Manage contact information" field so the webhook mirrors
    // exactly what directory-sync would have written on a full walk —
    // otherwise webhook-driven updates would clobber the contact columns
    // with nulls.
    const r = await fetch(`${GRAPH_BASE}/users/${extId}?$select=id,userPrincipalName,displayName,givenName,surname,mail,jobTitle,department,accountEnabled,onPremisesSamAccountName,officeLocation,businessPhones,faxNumber,mobilePhone,streetAddress,city,state,postalCode,country`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 404) {
      // Race: deleted before our fetch reached it. Remove local row.
      await admin.from("directory_users")
        .delete().eq("org_id", orgId).eq("provider", "m365").eq("external_id", extId);
      return;
    }
    if (!r.ok) throw new Error(`graph users/${extId}: ${r.status} ${await r.text()}`);
    const u = await r.json();
    const phones = Array.isArray(u.businessPhones) ? u.businessPhones as string[] : [];
    await admin.from("directory_users").upsert({
      org_id: orgId, provider: "m365",
      external_id: u.id,
      upn: u.userPrincipalName ?? null,
      display_name: u.displayName ?? null,
      mail: u.mail ?? null,
      given_name: u.givenName ?? null,
      surname: u.surname ?? null,
      job_title: u.jobTitle ?? null,
      department: u.department ?? null,
      account_enabled: u.accountEnabled ?? null,
      is_shared_mailbox: false,
      office_location: u.officeLocation ?? null,
      office_phone:    phones[0] ?? null,
      fax_number:      u.faxNumber ?? null,
      mobile_phone:    u.mobilePhone ?? null,
      street_address:  u.streetAddress ?? null,
      city:            u.city ?? null,
      state_province:  u.state ?? null,
      postal_code:     u.postalCode ?? null,
      country:         u.country ?? null,
      raw: u, synced_at: new Date().toISOString(),
    }, { onConflict: "org_id,provider,external_id" });

    // Reverse sync — mirror Graph's manager onto employees.manager_id so the
    // portal reflects M365 admin-portal edits in near-real-time. Errors here
    // are non-fatal (directory_users upsert already succeeded).
    try {
      const mr = await fetch(`${GRAPH_BASE}/users/${extId}/manager?$select=id`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const { data: empRow } = await admin
        .from("employees")
        .select("id, manager_id")
        .eq("org_id", orgId)
        .eq("m365_user_id", extId)
        .maybeSingle();
      const emp = empRow as { id: string; manager_id: string | null } | null;
      if (emp) {
        let newManagerId: string | null = null;
        if (mr.ok) {
          const mgr = await mr.json() as { id?: string };
          if (mgr?.id) {
            const { data: mgrEmp } = await admin
              .from("employees")
              .select("id")
              .eq("org_id", orgId)
              .eq("m365_user_id", mgr.id)
              .maybeSingle();
            newManagerId = (mgrEmp as { id: string } | null)?.id ?? null;
          }
        } else if (mr.status !== 404) {
          console.warn(`[m365-webhook] manager fetch for ${extId}: ${mr.status}`);
        }
        // 404 from Graph = no manager set → newManagerId stays null (clear).
        if (newManagerId !== emp.manager_id) {
          await admin.from("employees")
            .update({ manager_id: newManagerId })
            .eq("id", emp.id);
          console.info(`[m365-webhook] reverse-sync manager: ${emp.id} → ${newManagerId ?? "(cleared)"}`);
        }
      }
    } catch (e) {
      console.warn(`[m365-webhook] reverse manager sync failed for ${extId}: ${(e as Error).message}`);
    }

    // Auto-apply the org's active signature template to newly-created users.
    // Runs fire-and-forget so the webhook still returns to Graph within its
    // response budget (Graph gives us ~30s before retrying). A single push
    // typically completes in 2-5s; if Exchange is slow we let it finish
    // asynchronously — the push function updates signature_push_status so the
    // admin UI shows the outcome regardless.
    if (n.changeType === "created") {
      try {
        const { data: tpl } = await admin
          .from("signature_templates")
          .select("id")
          .eq("org_id", orgId)
          .eq("is_active", true)
          .maybeSingle();
        if (tpl?.id) {
          const { data: newEmp } = await admin
            .from("employees").select("id")
            .eq("org_id", orgId)
            .eq("m365_user_id", extId)
            .maybeSingle();
          // Skip if the employee row hasn't been created yet — HR usually
          // creates it during onboarding, and admin can manually push once
          // the employee exists. We do NOT fall back to "all" here because
          // that would blast every user in the org on a single-user event.
          if (newEmp?.id) {
            void fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/signatures-push`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                template_id: tpl.id,
                org_id: orgId,
                employee_ids: [newEmp.id],
              }),
            }).catch((e) => console.warn(`[m365-webhook] signature auto-push failed for ${extId}: ${(e as Error).message}`));
          }
        }
      } catch (e) {
        console.warn(`[m365-webhook] signature auto-push lookup for ${extId}: ${(e as Error).message}`);
      }
    }
    return;
  }

  // Groups — also re-walk members on every update because membership
  // changes don't deliver their own resource path. (Graph notifies on
  // "groups/<id>" with changeType=updated when a member is added/removed.)
  const gr = await fetch(`${GRAPH_BASE}/groups/${extId}?$select=id,displayName,description,mailEnabled,securityEnabled,groupTypes,visibility,mail,onPremisesSyncEnabled`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (gr.status === 404) {
    await admin.from("directory_groups")
      .delete().eq("org_id", orgId).eq("provider", "m365").eq("external_id", extId);
    return;
  }
  if (!gr.ok) throw new Error(`graph groups/${extId}: ${gr.status} ${await gr.text()}`);
  const g = await gr.json();
  const isUnified = Array.isArray(g.groupTypes) && g.groupTypes.includes("Unified");
  const reason: string | null = g.onPremisesSyncEnabled
    ? "on-prem-synced"
    : (g.mailEnabled && !isUnified)
      ? "mail-enabled"
      : null;
  await admin.from("directory_groups").upsert({
    org_id: orgId, provider: "m365",
    external_id: g.id,
    display_name: g.displayName ?? null,
    description: g.description ?? null,
    visibility: g.visibility ?? null,
    mail: g.mail ?? null,
    mail_enabled: !!g.mailEnabled,
    security_enabled: !!g.securityEnabled,
    is_writable: reason === null,
    writable_reason: reason,
    raw: g, synced_at: new Date().toISOString(),
  }, { onConflict: "org_id,provider,external_id" });

  // Re-walk membership for the changed group. Skip cleanly on 404 (group
  // unreachable for member expansion).
  const { data: dbg } = await admin
    .from("directory_groups")
    .select("id")
    .eq("org_id", orgId).eq("provider", "m365").eq("external_id", extId)
    .maybeSingle();
  const intId = (dbg as { id: string } | null)?.id;
  if (!intId) return;

  const memberRows: Record<string, unknown>[] = [];
  let memberCt = 0, ownerCt = 0;
  try {
    const mr = await fetch(`${GRAPH_BASE}/groups/${extId}/members?$select=id&$top=999`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (mr.ok) {
      const mj = await mr.json() as { value?: Array<{ id: string }> };
      for (const x of (mj.value ?? [])) { memberRows.push({ org_id: orgId, group_id: intId, external_user_id: x.id, role: "member" }); memberCt++; }
    }
    const or = await fetch(`${GRAPH_BASE}/groups/${extId}/owners?$select=id&$top=999`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (or.ok) {
      const oj = await or.json() as { value?: Array<{ id: string }> };
      for (const x of (oj.value ?? [])) { memberRows.push({ org_id: orgId, group_id: intId, external_user_id: x.id, role: "owner" }); ownerCt++; }
    }
  } catch (e) {
    // Soft-fail: the group row was upserted; member sync can be retried later.
    console.warn(`[m365-webhook] member walk for ${extId} failed: ${(e as Error).message}`);
  }
  await admin.from("directory_group_members").delete().eq("group_id", intId);
  if (memberRows.length) {
    await admin.from("directory_group_members").upsert(memberRows, { onConflict: "group_id,external_user_id,role" });
  }
  await admin.from("directory_groups").update({
    members_count: memberCt, owners_count: ownerCt, synced_at: new Date().toISOString(),
  }).eq("id", intId);
}

function text(body: string, status: number) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain", ...corsHeaders } });
}
function queueBackground(fn: () => Promise<unknown>): void {
  const p = fn();
  // deno-lint-ignore no-explicit-any
  if (typeof (globalThis as any).EdgeRuntime !== "undefined" && (globalThis as any).EdgeRuntime?.waitUntil) {
    (globalThis as any).EdgeRuntime.waitUntil(p);
  }
}
