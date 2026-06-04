// Shared helpers for /gov-* edge functions. Centralizes:
//   • bearer extraction + user resolution
//   • org write-gate (owner/admin via resolveWriterOrgId)
//   • audit-log insert via the gov_log_audit RPC
//
// Each gov-* function imports authzWriter() + logAudit() so we don't repeat
// 30 lines of auth boilerplate per file.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { corsHeaders } from "./cors.ts";
import { resolveWriterOrgId } from "./auth-org.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export interface AuthzResult {
  admin: SupabaseClient;
  userId: string;
  orgId: string;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function bearer(req: Request): string {
  const a = req.headers.get("authorization") ?? "";
  return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
}

/**
 * Verify the caller's bearer JWT, resolve their writer org. Returns null +
 * a Response if anything fails — caller should `return res` early.
 *
 *   const r = await authzWriter(req);
 *   if (!('admin' in r)) return r;        // r is a Response
 *   const { admin, userId, orgId } = r;
 */
export async function authzWriter(req: Request): Promise<AuthzResult | Response> {
  const jwt = bearer(req);
  if (!jwt) return jsonResponse({ error: "missing user token" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return jsonResponse({ error: "invalid token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const orgId = await resolveWriterOrgId(admin, u.user.id);
  if (!orgId) return jsonResponse({ error: "owner/admin role required" }, 403);

  return { admin, userId: u.user.id, orgId };
}

/** Append-only audit log via the SECURITY DEFINER RPC. Failures swallowed
 *  (audit is best-effort — never blocks the operation). */
export async function logAudit(
  admin: SupabaseClient,
  orgId: string,
  entityType: string,
  entityId: string | null,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await admin.rpc("gov_log_audit", {
      p_org_id: orgId,
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_action: action,
      p_detail: detail,
    });
  } catch (e) {
    console.warn(`[gov-audit] failed to log ${entityType}.${action}: ${(e as Error).message}`);
  }
}
