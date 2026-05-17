// Shared org-resolution helper. Used by every edge function that needs to
// figure out which org a user belongs to with write privileges. Replaces the
// repeated "eq('owner_user_id', callerId)" pattern, which excluded Org Admins
// (who are members with role='admin', not owners).
//
// Returns the first org where the caller is either:
//   • the organizations.owner_user_id, OR
//   • an org_members row with role in ('owner', 'admin')
//
// Used by: org-settings-save, employee-save, asset-assign, etc. — anywhere a
// "this user manages an org" check is needed.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

export async function resolveWriterOrgId(
  admin: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data: member } = await admin
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .in("role", ["owner", "admin"])
    .limit(1)
    .maybeSingle();
  if (member?.org_id) return member.org_id as string;

  const { data: owned } = await admin
    .from("organizations")
    .select("id")
    .eq("owner_user_id", userId)
    .limit(1);
  return owned?.[0]?.id ?? null;
}
