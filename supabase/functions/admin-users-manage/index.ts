// POST /functions/v1/admin-users-manage
// Headers: Authorization: Bearer <super_admin user JWT>
// Body:    { action: 'invite' | 'revoke' | 'grant' | 'reset_password' | 'disable' | 'enable' | 'delete',
//            email?: string, full_name?: string, user_id?: string }
//
// Lets an existing super_admin add / remove / disable / delete other super_admins.
//
//  action='invite' { email, full_name? }
//     If a user with this email already exists in auth.users → grant
//     super_admin directly. Else send an invite via auth.admin.inviteUserByEmail
//     and pre-stage the row in app_users so the role applies on first login.
//
//  action='grant'  { user_id }   — promote existing user to super_admin
//  action='revoke' { user_id }   — remove super_admin role (deletes app_users row)
//
// Self-revoke is blocked so the last super_admin can't lock themselves out.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Authorize: caller must already be super_admin.
  const { data: caller } = await admin.from("app_users").select("app_role").eq("user_id", u.user.id).maybeSingle();
  if (caller?.app_role !== "super_admin") {
    return json({ error: "only super_admins can manage admin users" }, 403);
  }

  let body: { action?: string; email?: string; full_name?: string; user_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const action = body.action;
  const KNOWN = ["invite", "grant", "revoke", "reset_password", "disable", "enable", "delete"];
  if (!KNOWN.includes(action ?? "")) {
    return json({ error: `action must be one of: ${KNOWN.join(", ")}` }, 400);
  }

  if (action === "invite") {
    const email = (body.email ?? "").trim().toLowerCase();
    if (!email.includes("@")) return json({ error: "valid email required" }, 400);

    // Does a user already exist with this email?
    const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const found = existing?.users?.find((x) => x.email?.toLowerCase() === email);

    if (found) {
      const { error: upErr } = await admin.from("app_users")
        .upsert({ user_id: found.id, app_role: "super_admin" }, { onConflict: "user_id" });
      if (upErr) return json({ error: `app_users: ${upErr.message}` }, 500);
      return json({ ok: true, status: "granted_existing", user_id: found.id, email }, 200);
    }

    // New user → invite via Supabase Auth.
    const { data: invited, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: body.full_name ?? null, role: "super_admin" },
    });
    if (invErr) return json({ error: `invite: ${invErr.message}` }, 500);

    // Pre-stage the role so it's already super_admin when they accept.
    if (invited?.user) {
      await admin.from("app_users")
        .upsert({ user_id: invited.user.id, app_role: "super_admin" }, { onConflict: "user_id" });
    }
    return json({ ok: true, status: "invited", email }, 200);
  }

  if (action === "grant") {
    const userId = (body.user_id ?? "").trim();
    if (!userId) return json({ error: "user_id required" }, 400);
    const { error } = await admin.from("app_users")
      .upsert({ user_id: userId, app_role: "super_admin" }, { onConflict: "user_id" });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, status: "granted" }, 200);
  }

  // From here on we need a user_id.
  const userId = (body.user_id ?? "").trim();
  if (!userId) return json({ error: "user_id required" }, 400);
  const isSelf = userId === u.user.id;

  if (action === "reset_password") {
    const { data: target } = await admin.auth.admin.getUserById(userId);
    if (!target?.user?.email) return json({ error: "user has no email" }, 400);
    // SITE_URL only points to the bare app origin — explicitly redirect to
    // /reset-password so the user actually lands on the new-password form
    // (the recovery hash params come along in the URL fragment).
    const appUrl = (Deno.env.get("APP_URL") ?? Deno.env.get("SITE_URL") ?? "https://app.rudrans.com").replace(/\/+$/, "");
    const { error: rpErr } = await admin.auth.resetPasswordForEmail(target.user.email, {
      redirectTo: `${appUrl}/reset-password`,
    });
    if (rpErr) return json({ error: rpErr.message }, 500);
    return json({ ok: true, status: "reset_sent", email: target.user.email }, 200);
  }

  if (action === "disable") {
    if (isSelf) return json({ error: "you cannot disable your own account" }, 400);
    const { error: bErr } = await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
    if (bErr) return json({ error: bErr.message }, 500);
    return json({ ok: true, status: "disabled" }, 200);
  }

  if (action === "enable") {
    const { error: bErr } = await admin.auth.admin.updateUserById(userId, { ban_duration: "none" });
    if (bErr) return json({ error: bErr.message }, 500);
    return json({ ok: true, status: "enabled" }, 200);
  }

  if (action === "delete") {
    if (isSelf) return json({ error: "you cannot delete your own account" }, 400);
    const { count } = await admin.from("app_users").select("user_id", { count: "exact", head: true }).eq("app_role", "super_admin");
    // Only block if the target is currently a super_admin AND is the last one.
    const { data: targetRole } = await admin.from("app_users").select("app_role").eq("user_id", userId).maybeSingle();
    if (targetRole?.app_role === "super_admin" && (count ?? 0) <= 1) {
      return json({ error: "cannot delete the last super_admin — promote someone else first" }, 400);
    }
    await admin.from("app_users").delete().eq("user_id", userId);
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) return json({ error: delErr.message }, 500);
    return json({ ok: true, status: "deleted" }, 200);
  }

  // revoke
  if (isSelf) {
    return json({ error: "you cannot revoke your own super_admin role" }, 400);
  }
  const { count } = await admin.from("app_users").select("user_id", { count: "exact", head: true }).eq("app_role", "super_admin");
  if ((count ?? 0) <= 1) {
    return json({ error: "cannot revoke the last super_admin — promote someone else first" }, 400);
  }
  const { error } = await admin.from("app_users").delete().eq("user_id", userId).eq("app_role", "super_admin");
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, status: "revoked" }, 200);
});

function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}
function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
