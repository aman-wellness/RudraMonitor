// Shared helper for looking up an auth.users row by email — replaces the
// broken `admin.auth.admin.listUsers({ page: 1, perPage: 1 })` pattern that
// only returned the first user in the table.
//
// Backs onto the `find_auth_user_id_by_email` SECURITY DEFINER RPC
// (migration 0104) since PostgREST doesn't expose the auth schema on
// self-hosted Supabase.

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

export async function findAuthUserIdByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<string | null> {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return null;
  const { data, error } = await admin.rpc("find_auth_user_id_by_email", { p_email: e });
  if (error) {
    console.error("find_auth_user_id_by_email failed:", error.message);
    return null;
  }
  return (data as string | null) ?? null;
}
