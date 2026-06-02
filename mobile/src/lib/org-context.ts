// Tracks which organisation the current user is "uploading into".
//
// Most customers belong to exactly one org → trivial. Some users belong
// to multiple (partners, agency staff) — for those we surface a tiny
// switcher in the header so a wrong-org accident can't happen silently.
//
// The selected org_id is cached in @capacitor/preferences so it persists
// across cold starts. Cleared on sign-out (see Settings.tsx).

import { supabase } from "./supabase";
import { Preferences } from "@capacitor/preferences";

const PREF_KEY = "selected_org_id";

export interface OrgMembership {
  org_id: string;
  org_name: string;
  role: string;
}

export async function listMyOrgs(): Promise<OrgMembership[]> {
  // org_members RLS lets the caller see their own rows; the org row is
  // implicit-joined via FK. We query the FK manually to keep the shape
  // predictable.
  const { data: members } = await supabase
    .from("org_members")
    .select("org_id, role");
  if (!members?.length) return [];
  const ids = (members as Array<{ org_id: string; role: string }>).map((m) => m.org_id);
  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name")
    .in("id", ids);
  const nameById = new Map<string, string>(
    (orgs ?? []).map((o: { id: string; name: string | null }) => [o.id, o.name ?? "(unnamed)"]),
  );
  return (members as Array<{ org_id: string; role: string }>).map((m) => ({
    org_id: m.org_id,
    org_name: nameById.get(m.org_id) ?? "(unnamed org)",
    role: m.role,
  }));
}

// Returns the org_id the user is currently uploading into. If we saved a
// previous choice, validate it's still valid (user may have left that
// org); otherwise return the first membership.
export async function getActiveOrg(orgs: OrgMembership[]): Promise<OrgMembership | null> {
  if (orgs.length === 0) return null;
  const { value } = await Preferences.get({ key: PREF_KEY });
  const cached = value ? orgs.find((o) => o.org_id === value) : undefined;
  return cached ?? orgs[0];
}

export async function setActiveOrg(orgId: string): Promise<void> {
  await Preferences.set({ key: PREF_KEY, value: orgId });
}

export async function clearActiveOrg(): Promise<void> {
  await Preferences.remove({ key: PREF_KEY });
}
