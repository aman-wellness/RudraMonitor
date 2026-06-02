// POST /functions/v1/directory-sync
//
// Two invocation modes:
//   • User-JWT mode (Authorization: Bearer <user-jwt>, body: {provider?}):
//       resolves caller's org and syncs M365 / Google / both. Returns 202
//       immediately with status:"syncing" — actual work continues in the
//       background via EdgeRuntime.waitUntil so the browser can navigate away
//       without aborting. UI polls org_integrations_safe to see when it's done.
//
//   • Service-role mode (Authorization: Bearer <service-role-jwt>,
//       body: {scheduled: true}): iterates every (org, provider) where
//       status in ('active','syncing','error') and runs sync for each in the
//       background. Used by the pg_cron job that fires every 5 min.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";
import { graphPaged } from "../_shared/graph.ts";
import { googlePaged } from "../_shared/google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ error: "missing token" }, 401);

  let body: { provider?: string; scheduled?: boolean } = {};
  try { body = await req.json(); } catch { /* allow empty body */ }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---------- service-role / scheduled mode ----------
  if (jwt === SERVICE_ROLE_KEY) {
    const { data: rows } = await admin
      .from("org_integrations")
      .select("org_id, provider, status")
      .in("status", ["active", "syncing", "error"]);
    const targets = rows ?? [];
    queueBackground(async () => {
      for (const t of targets) {
        try {
          if (t.provider === "m365") await syncOne(admin, t.org_id as string, "m365");
          else if (t.provider === "google") await syncOne(admin, t.org_id as string, "google");
        } catch (e) {
          await markError(admin, t.org_id as string, t.provider as string, (e as Error).message);
        }
      }
    });
    return json({ ok: true, scheduled: true, targets: targets.length }, 202);
  }

  // ---------- user-JWT mode ----------
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "invalid token" }, 401);
  const { resolveWriterOrgId } = await import("../_shared/auth-org.ts");
  const orgId = await resolveWriterOrgId(admin, u.user.id);
  if (!orgId) return json({ error: "no org for caller" }, 403);
  const which = (body.provider ?? "all") as "m365" | "google" | "all";

  // Mark BOTH providers as 'syncing' synchronously so UI immediately reflects it.
  const providers: Array<"m365" | "google"> = which === "all" ? ["m365", "google"] : [which];
  for (const p of providers) {
    await admin.from("org_integrations")
      .update({ status: "syncing", last_sync_error: null })
      .eq("org_id", orgId).eq("provider", p);
  }

  queueBackground(async () => {
    for (const p of providers) {
      try {
        await syncOne(admin, orgId, p);
      } catch (e) {
        await markError(admin, orgId, p, (e as Error).message);
      }
    }
  });

  return json({ ok: true, org_id: orgId, status: "syncing", providers }, 202);
});

// ============== one (org, provider) sync ==============

async function syncOne(admin: ReturnType<typeof createClient>, orgId: string, provider: "m365" | "google"): Promise<void> {
  // If not actively connected, nothing to do — but ensure we don't leave a stuck 'syncing' row.
  const { data: conn } = await admin.from("org_integrations").select("status").eq("org_id", orgId).eq("provider", provider).maybeSingle();
  if (!conn) return;
  if (!["active", "syncing"].includes(conn.status as string)) return;

  // Make sure status is 'syncing' for the duration.
  await admin.from("org_integrations").update({ status: "syncing", last_sync_error: null }).eq("org_id", orgId).eq("provider", provider);

  try {
    if (provider === "m365") await syncM365(admin, orgId);
    else                      await syncGoogle(admin, orgId);

    await admin.from("org_integrations").update({
      status: "active",
      last_sync_at: new Date().toISOString(),
      last_sync_error: null,
    }).eq("org_id", orgId).eq("provider", provider);
  } catch (e) {
    await markError(admin, orgId, provider, (e as Error).message);
    throw e;
  }
}

async function markError(admin: ReturnType<typeof createClient>, orgId: string, provider: string, msg: string): Promise<void> {
  await admin.from("org_integrations").update({
    status: "error",
    last_sync_at: new Date().toISOString(),
    last_sync_error: msg,
  }).eq("org_id", orgId).eq("provider", provider);
}

// ============== M365 sync ==============

async function syncM365(admin: ReturnType<typeof createClient>, orgId: string): Promise<void> {
  // NOTE: `signInActivity` deliberately omitted — Graph requires the extra
  // AuditLog.Read.All permission to return it and a 403 on that single field
  // aborts the entire paged enumeration. Re-add via a second call once the
  // customer grants AuditLog.Read.All.
  const userRows: Record<string, unknown>[] = [];
  // Extended $select pulls every "Manage contact information" field so the
  // Rudrans Employees page mirrors the M365 admin centre 1:1. The phone
  // fields come back as arrays from Graph (businessPhones); we collapse to
  // the first element since our DB stores a single office_phone string.
  for await (const u of graphPaged<Record<string, unknown>>(orgId, "/users", {
    "$select": "id,userPrincipalName,displayName,mail,givenName,surname,jobTitle,department,accountEnabled,userType,officeLocation,businessPhones,faxNumber,mobilePhone,streetAddress,city,state,postalCode,country",
    "$top": 999,
  })) {
    const phones = Array.isArray(u.businessPhones) ? u.businessPhones as string[] : [];
    userRows.push({
      org_id: orgId, provider: "m365",
      external_id: u.id as string,
      upn: u.userPrincipalName as string ?? null,
      display_name: u.displayName as string ?? null,
      mail: u.mail as string ?? null,
      given_name: u.givenName as string ?? null,
      surname: u.surname as string ?? null,
      job_title: u.jobTitle as string ?? null,
      department: u.department as string ?? null,
      account_enabled: (u.accountEnabled as boolean) ?? null,
      is_shared_mailbox: false,
      last_signin_at: null,
      office_location: u.officeLocation as string ?? null,
      office_phone:    phones[0] ?? null,
      fax_number:      u.faxNumber as string ?? null,
      mobile_phone:    u.mobilePhone as string ?? null,
      street_address:  u.streetAddress as string ?? null,
      city:            u.city as string ?? null,
      state_province:  u.state as string ?? null,
      postal_code:     u.postalCode as string ?? null,
      country:         u.country as string ?? null,
      raw: u,
      synced_at: new Date().toISOString(),
    });
  }
  for (const chunk of chunked(userRows, 500)) {
    const { error } = await admin.from("directory_users").upsert(chunk, { onConflict: "org_id,provider,external_id" });
    if (error) throw new Error(`m365 users upsert: ${error.message}`);
  }

  const groupRows: Record<string, unknown>[] = [];
  for await (const g of graphPaged<Record<string, unknown>>(orgId, "/groups", {
    "$select": "id,displayName,mail,description,visibility,groupTypes,securityEnabled,mailEnabled,resourceProvisioningOptions,onPremisesSyncEnabled,membershipRule,isAssignableToRole",
    "$top": 999,
  })) {
    const types = (g.groupTypes as string[]) ?? [];
    const provisioning = (g.resourceProvisioningOptions as string[]) ?? [];
    const isTeam = provisioning.includes("Team");
    const groupType = isTeam ? "team"
      : types.includes("Unified") ? "m365_group"
      : g.mailEnabled ? "distribution"
      : "security";

    // Determine why Graph won't let us mutate this group's membership.
    const isDynamic = types.includes("DynamicMembership") || !!g.membershipRule;
    const isOnPrem = !!g.onPremisesSyncEnabled;
    const isRoleAssignable = !!g.isAssignableToRole;
    const writable = !(isDynamic || isOnPrem || isRoleAssignable);
    const reason = isOnPrem ? "Synced from on-prem Active Directory"
      : isDynamic ? "Dynamic membership rule — managed automatically"
      : isRoleAssignable ? "Role-assignable — protected by Microsoft"
      : null;

    groupRows.push({
      org_id: orgId, provider: "m365",
      external_id: g.id as string,
      group_type: groupType,
      display_name: g.displayName as string ?? null,
      mail: g.mail as string ?? null,
      description: g.description as string ?? null,
      visibility: g.visibility as string ?? null,
      is_team: isTeam,
      is_writable: writable,
      writable_reason: reason,
      owners_count: 0, members_count: 0,
      raw: g, synced_at: new Date().toISOString(),
    });
  }
  for (const chunk of chunked(groupRows, 500)) {
    const { error } = await admin.from("directory_groups").upsert(chunk, { onConflict: "org_id,provider,external_id" });
    if (error) throw new Error(`m365 groups upsert: ${error.message}`);
  }

  const { data: dbGroups } = await admin.from("directory_groups").select("id, external_id").eq("org_id", orgId).eq("provider", "m365");
  const groupIdByExternal = new Map<string, string>((dbGroups ?? []).map((g: { id: string; external_id: string }) => [g.external_id, g.id]));

  // Groups can disappear between listGroups() and the per-group member
  // enumeration (admin deleted them in Azure AD), and some special
  // group types (mail-enabled distribution groups, on-prem-synced groups,
  // service-principal-owned groups) reply 404 on member expansion even
  // though they showed up in the list. Both cases used to abort the
  // entire sync. Now we count them as "skipped" and continue — the rest
  // of the org's users + groups still land cleanly.
  let skippedGroups = 0;
  for (const [extId, intId] of groupIdByExternal) {
    const memberRows: Record<string, unknown>[] = [];
    let ownerCt = 0, memberCt = 0;
    try {
      for await (const m of graphPaged<Record<string, unknown>>(orgId, `/groups/${extId}/members`, { "$select": "id", "$top": 999 })) {
        memberRows.push({ org_id: orgId, group_id: intId, external_user_id: m.id as string, role: "member" });
        memberCt++;
      }
      for await (const o of graphPaged<Record<string, unknown>>(orgId, `/groups/${extId}/owners`, { "$select": "id", "$top": 999 })) {
        memberRows.push({ org_id: orgId, group_id: intId, external_user_id: o.id as string, role: "owner" });
        ownerCt++;
      }
    } catch (e) {
      const msg = (e as Error).message;
      // 404 = group vanished or unsupported for member expansion. Skip cleanly.
      // Anything else (auth, rate-limit, 5xx) is a real failure — re-throw.
      if (/\b404\b/.test(msg) && /Request_ResourceNotFound|does not exist/i.test(msg)) {
        skippedGroups++;
        console.warn(`[directory-sync] m365 group ${extId} skipped: ${msg.slice(0, 200)}`);
        continue;
      }
      throw e;
    }
    await admin.from("directory_group_members").delete().eq("group_id", intId);
    if (memberRows.length) {
      const { error } = await admin.from("directory_group_members").upsert(memberRows, { onConflict: "group_id,external_user_id,role" });
      if (error) throw new Error(`m365 members upsert (${extId}): ${error.message}`);
    }
    await admin.from("directory_groups").update({ members_count: memberCt, owners_count: ownerCt, synced_at: new Date().toISOString() }).eq("id", intId);
  }
  if (skippedGroups > 0) {
    console.log(`[directory-sync] m365 sync complete; ${skippedGroups} group(s) skipped (deleted or unsupported)`);
  }
}

// ============== Google sync ==============

async function syncGoogle(admin: ReturnType<typeof createClient>, orgId: string): Promise<void> {
  const { data: conn } = await admin.from("org_integrations").select("tenant_id").eq("org_id", orgId).eq("provider", "google").maybeSingle();
  const customer = conn?.tenant_id ?? "my_customer";

  const userRows: Record<string, unknown>[] = [];
  for await (const u of googlePaged<Record<string, unknown>>(orgId, "/users", "users", { customer, projection: "full" })) {
    userRows.push({
      org_id: orgId, provider: "google",
      external_id: u.id as string,
      upn: u.primaryEmail as string ?? null,
      display_name: (u.name as { fullName?: string } | undefined)?.fullName ?? null,
      mail: u.primaryEmail as string ?? null,
      given_name: (u.name as { givenName?: string } | undefined)?.givenName ?? null,
      surname: (u.name as { familyName?: string } | undefined)?.familyName ?? null,
      job_title: (u.organizations as { title?: string }[] | undefined)?.[0]?.title ?? null,
      department: (u.organizations as { department?: string }[] | undefined)?.[0]?.department ?? null,
      account_enabled: !(u.suspended as boolean | undefined),
      is_shared_mailbox: false,
      last_signin_at: u.lastLoginTime as string ?? null,
      raw: u, synced_at: new Date().toISOString(),
    });
  }
  for (const chunk of chunked(userRows, 500)) {
    const { error } = await admin.from("directory_users").upsert(chunk, { onConflict: "org_id,provider,external_id" });
    if (error) throw new Error(`google users upsert: ${error.message}`);
  }

  const groupRows: Record<string, unknown>[] = [];
  for await (const g of googlePaged<Record<string, unknown>>(orgId, "/groups", "groups", { customer })) {
    groupRows.push({
      org_id: orgId, provider: "google",
      external_id: g.id as string,
      group_type: "google_group",
      display_name: g.name as string ?? null,
      mail: g.email as string ?? null,
      description: g.description as string ?? null,
      visibility: null, is_team: false,
      owners_count: 0, members_count: Number(g.directMembersCount ?? 0),
      raw: g, synced_at: new Date().toISOString(),
    });
  }
  for (const chunk of chunked(groupRows, 500)) {
    const { error } = await admin.from("directory_groups").upsert(chunk, { onConflict: "org_id,provider,external_id" });
    if (error) throw new Error(`google groups upsert: ${error.message}`);
  }
  const { data: dbGroups } = await admin.from("directory_groups").select("id, external_id").eq("org_id", orgId).eq("provider", "google");
  const groupIdByExternal = new Map<string, string>((dbGroups ?? []).map((g: { id: string; external_id: string }) => [g.external_id, g.id]));

  // Same "group vanished between list and member fetch" resilience as
  // the M365 path. Google returns 404 (sometimes 403 on Suspended groups);
  // both are transient per-group failures and shouldn't abort the run.
  let skippedGroups = 0;
  for (const [extId, intId] of groupIdByExternal) {
    const memberRows: Record<string, unknown>[] = [];
    let ownerCt = 0, memberCt = 0;
    try {
      for await (const m of googlePaged<Record<string, unknown>>(orgId, `/groups/${extId}/members`, "members", {})) {
        const role = ((m.role as string) || "MEMBER").toLowerCase() === "owner" ? "owner" : "member";
        memberRows.push({ org_id: orgId, group_id: intId, external_user_id: m.id as string, role });
        if (role === "owner") ownerCt++; else memberCt++;
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/\b40[34]\b/.test(msg)) {
        skippedGroups++;
        console.warn(`[directory-sync] google group ${extId} skipped: ${msg.slice(0, 200)}`);
        continue;
      }
      throw e;
    }
    await admin.from("directory_group_members").delete().eq("group_id", intId);
    if (memberRows.length) {
      const { error } = await admin.from("directory_group_members").upsert(memberRows, { onConflict: "group_id,external_user_id,role" });
      if (error) throw new Error(`google members upsert (${extId}): ${error.message}`);
    }
    await admin.from("directory_groups").update({ members_count: memberCt, owners_count: ownerCt, synced_at: new Date().toISOString() }).eq("id", intId);
  }
  if (skippedGroups > 0) {
    console.log(`[directory-sync] google sync complete; ${skippedGroups} group(s) skipped`);
  }
}

// ============== helpers ==============

function queueBackground(fn: () => Promise<unknown>): void {
  const p = fn();
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(p);
  }
  // p is also kept alive by the closure; even without EdgeRuntime it'll run.
}
function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
