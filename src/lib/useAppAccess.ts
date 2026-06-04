// Per-user feature whitelist. Driven by org_members.app_access (added
// in migration 0080). Pairs with org-level subscription gating from
// useFeatures — the sidebar/router only show an item when BOTH:
//
//   • the org subscription includes the feature (useFeatures), AND
//   • this user has the feature in their personal app_access list
//
// Owners / admins always pass the second check. Lower roles default to
// "everything" UNTIL an admin scopes them down via Admin Portal → Users.
//
// app_access semantics:
//   NULL  → inherit org default (= every paid feature). Same as today's
//           behaviour, so existing rows need no migration.
//   []    → no features (login-only, useful for billing-contact users).
//   ['credentials'] → only Credentials Vault.

import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { useAuth } from '../context/AuthContext';

// Canonical list of feature codes the dashboard knows about. Keep in
// lock-step with sidebarLinks in DashboardLayout.tsx + RequireFeature.
// The Admin Portal "Add / Edit User" UI uses this for the checkbox grid.
export const APP_ACCESS_CODES = [
  { code: 'dashboard',           label: 'Dashboard',              hint: 'Org overview, summary cards' },
  { code: 'agents',              label: 'Agents',                 hint: 'Agent list + per-agent detail' },
  { code: 'monitoring',          label: 'Live Monitoring',        hint: 'Apps, Browser, Live, Remote, Screenshots, Idle' },
  { code: 'alerts',              label: 'Alerts',                 hint: 'AI-classified alerts feed' },
  { code: 'dlp',                 label: 'DLP',                    hint: 'Data-loss-prevention events' },
  { code: 'system_health',       label: 'System Health',          hint: 'CPU / RAM / disk telemetry' },
  { code: 'performance',         label: 'Performance Reports',    hint: 'Productivity rollups' },
  { code: 'reports',             label: 'Reports',                hint: 'Activity reports / exports' },
  { code: 'setup',               label: 'Agent Setup',            hint: 'Download installers, license keys' },
  { code: 'employees',           label: 'Employees',              hint: 'Employee directory + provisioning' },
  { code: 'groups',              label: 'Groups & Teams',         hint: 'Manage M365/Google groups' },
  { code: 'managers',            label: 'Managers',               hint: 'Manager → reports relationships' },
  { code: 'credentials',         label: 'Credentials Vault',      hint: 'Shared logins / passwords + billing' },
  { code: 'hardware',            label: 'IT Hardware',            hint: 'Asset inventory + assignments' },
  { code: 'offboarding',         label: 'Offboarding',            hint: 'Multi-stage exit workflow' },
  { code: 'integrations',        label: 'Integrations',           hint: 'M365 / Google Workspace sync' },
  { code: 'governance',          label: 'Governance',             hint: 'Pillars, org chart, channels, access register, policies' },
  { code: 'admin_portal',        label: 'Admin Portal',           hint: 'Org settings, users, billing' },
] as const;

export type AppAccessCode = typeof APP_ACCESS_CODES[number]['code'];

// Per-feature permission level. Additive: edit ⊃ view, full ⊃ edit.
//   view → read pages, exports
//   edit → view + create/update + upload + grant
//   full → edit + delete + danger-zone actions
export type AccessLevel = 'view' | 'edit' | 'full';

export interface AppAccessState {
  role: 'owner' | 'admin' | 'manager' | 'viewer' | null;
  /** Effective allowed feature codes for this user. */
  allowed: Set<AppAccessCode>;
  /** Per-feature level for codes in `allowed`. Owner/admin/unrestricted
   *  → every allowed code maps to 'full'. */
  levels: Map<AppAccessCode, AccessLevel>;
  /** Convenience: returns the level for a code, or null if not allowed.
   *  Owners/admins always get 'full'. */
  levelOf: (code: AppAccessCode) => AccessLevel | null;
  /** Convenience: true if user can perform a write-level action on this
   *  feature (level >= 'edit'). */
  canEdit: (code: AppAccessCode) => boolean;
  /** Convenience: true if user can perform a delete-level action on
   *  this feature (level === 'full'). */
  canDelete: (code: AppAccessCode) => boolean;
  /** True until the first my_app_access() call resolves. */
  loading: boolean;
  /** Convenience: true if the user can see literally every feature
   *  (owner / admin OR app_access is NULL). */
  unrestricted: boolean;
  refresh: () => Promise<void>;
}

const LEVEL_RANK: Record<AccessLevel, number> = { view: 1, edit: 2, full: 3 };
const isLevel = (v: unknown): v is AccessLevel =>
  v === 'view' || v === 'edit' || v === 'full';

const ALL_CODES = new Set<AppAccessCode>(APP_ACCESS_CODES.map((c) => c.code));

// Build the AppAccessState helper closures for a given (allowed,
// levels, unrestricted) snapshot. Pulled out of the load() body so
// the initial state can use the same closures and TS narrows happily.
const buildHelpers = (
  allowed: Set<AppAccessCode>,
  levels: Map<AppAccessCode, AccessLevel>,
  unrestricted: boolean,
) => {
  const levelOf = (code: AppAccessCode): AccessLevel | null => {
    if (unrestricted) return allowed.has(code) ? 'full' : null;
    if (!allowed.has(code)) return null;
    return levels.get(code) ?? 'full';
  };
  const atLeast = (code: AppAccessCode, min: AccessLevel) => {
    const l = levelOf(code);
    return l != null && LEVEL_RANK[l] >= LEVEL_RANK[min];
  };
  return {
    levelOf,
    canEdit:   (code: AppAccessCode) => atLeast(code, 'edit'),
    canDelete: (code: AppAccessCode) => atLeast(code, 'full'),
  };
};

export function useAppAccess(): AppAccessState {
  const { user } = useAuth();
  const [state, setState] = useState<AppAccessState>(() => {
    const allowed = new Set(ALL_CODES);
    const levels = new Map<AppAccessCode, AccessLevel>();
    const h = buildHelpers(allowed, levels, true);
    return {
      role: null, allowed, levels,
      loading: true, unrestricted: true,
      refresh: async () => {},
      ...h,
    };
  });

  const load = async () => {
    if (!user) {
      const allowed = new Set<AppAccessCode>();
      const levels = new Map<AppAccessCode, AccessLevel>();
      const h = buildHelpers(allowed, levels, false);
      setState((s) => ({ ...s, loading: false, allowed, levels, unrestricted: false, ...h }));
      return;
    }
    const { data } = await supabase.rpc('my_app_access');
    type Row = {
      role: 'owner' | 'admin' | 'manager' | 'viewer';
      app_access: string[] | null;
      app_access_levels: Record<string, string> | null;
    };
    const row = Array.isArray(data) && data.length > 0 ? (data[0] as Row) : null;
    const role = row?.role ?? null;
    // Owners / admins always see everything at 'full'. NULL app_access
    // also means "no restriction" (inherit org default = every paid
    // feature, full level).
    const unrestricted = role === 'owner' || role === 'admin' || row?.app_access == null;
    const allowed: Set<AppAccessCode> = unrestricted
      ? new Set(ALL_CODES)
      : new Set((row?.app_access ?? []).filter((c): c is AppAccessCode => ALL_CODES.has(c as AppAccessCode)));
    const levels = new Map<AppAccessCode, AccessLevel>();
    if (!unrestricted && row?.app_access_levels && typeof row.app_access_levels === 'object') {
      for (const [k, v] of Object.entries(row.app_access_levels)) {
        if (ALL_CODES.has(k as AppAccessCode) && allowed.has(k as AppAccessCode) && isLevel(v)) {
          levels.set(k as AppAccessCode, v);
        }
      }
    }
    const h = buildHelpers(allowed, levels, unrestricted);
    setState({ role, allowed, levels, loading: false, unrestricted, refresh: load, ...h });
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user?.id]);

  return state;
}
