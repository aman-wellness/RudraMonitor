// Feature-flag hooks driven by the per-org subscription state.
//
// Trial orgs see everything by default (so they can evaluate). Paid orgs only
// see modules they've subscribed to. The set of capabilities is computed by
// the `org_effective_features(org_id)` RPC — union of the org's active
// license's plan features PLUS any active add-ons (org_addons rows).
//
// Feature codes the rest of the app reads:
//   - monitoring_basic   Apps/Browser/Idle activity tracking (Starter+)
//   - screenshots        periodic screenshot capture (Pro+, Enterprise)
//   - videos             video clips (Pro+, Enterprise)
//   - live               WebRTC live monitoring tab (Pro+, Enterprise)
//   - remote             Remote Desktop tab (Pro+, Enterprise)
//   - dlp                Data Loss Prevention alerts (Pro+, Enterprise, DLP add-on)
//   - employee_management EM suite — provisioning, M365/Google sync, credentials
//                        vault, hardware, offboarding (EM standalone, Enterprise,
//                        EM add-on)
//
// Legacy plan codes (`productivity_reports`, `video_recording`, `ai_alerts`,
// `screenshots`) are mapped to the v2 codes below so existing customers see
// the same features they always have.

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

export type FeatureCode =
  | 'monitoring_basic'
  | 'screenshots'
  | 'videos'
  | 'live'
  | 'remote'
  | 'dlp'
  | 'employee_management';

export type OrgFeatures = {
  // Modern flags — always check these going forward.
  monitoring_basic_enabled: boolean;
  screenshots_enabled: boolean;
  videos_enabled: boolean;
  live_enabled: boolean;
  remote_enabled: boolean;
  dlp_enabled: boolean;
  em_enabled: boolean;

  // Legacy compatibility for older components that import these names.
  em_active: boolean;
  em_subscribed: boolean;
  em_subscribed_since: string | null;

  // Subscription metadata.
  subscription_status: string;
  trial_ends_at: string;
  on_trial: boolean;

  loading: boolean;
  refresh: () => Promise<void>;
};

// Translate legacy + v2 feature codes onto the v2 canonical set. This lets us
// keep older plan rows (`scale-100`, `growth-25`, etc.) working without
// re-seeding them.
const LEGACY_MAP: Record<string, FeatureCode[]> = {
  productivity_reports: ['monitoring_basic'],
  screenshots: ['monitoring_basic', 'screenshots'],
  video_recording: ['monitoring_basic', 'screenshots', 'videos'],
  ai_alerts: ['monitoring_basic'],
  dlp: ['dlp'],
};

function expandFeatures(raw: string[] | null | undefined): Set<FeatureCode> {
  const out = new Set<FeatureCode>();
  for (const f of raw ?? []) {
    const mapped = LEGACY_MAP[f];
    if (mapped) mapped.forEach((m) => out.add(m));
    else out.add(f as FeatureCode);
  }
  return out;
}

// Per-org feature cache (localStorage). The feature set rarely changes
// within a session, so we hydrate from cache on mount to avoid the
// "all items visible → filter → items disappear" flash on every reload.
// The async RPC then revalidates and updates the state if anything changed.
// Bump the version suffix any time we change the gating semantics — every
// browser will then discard its stale cached set and refetch fresh.
const CACHE_KEY = (orgId: string) => `rudrans:features:v2:${orgId}`;
type Cached = Omit<ReturnType<typeof emptyState>, 'refresh'>;
function emptyState() {
  return {
    monitoring_basic_enabled: false,
    screenshots_enabled: false,
    videos_enabled: false,
    live_enabled: false,
    remote_enabled: false,
    dlp_enabled: false,
    em_enabled: false,
    em_active: false,
    em_subscribed: false,
    em_subscribed_since: null as string | null,
    subscription_status: 'trial',
    trial_ends_at: '',
    on_trial: true,
    loading: true,
  };
}
function readCache(orgId: string | undefined): Cached | null {
  if (!orgId || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY(orgId));
    if (!raw) return null;
    return JSON.parse(raw) as Cached;
  } catch { return null; }
}
function writeCache(orgId: string, value: Cached) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(CACHE_KEY(orgId), JSON.stringify(value)); } catch { /* ignore */ }
}

export function useFeatures(): OrgFeatures {
  const { organization } = useAuth();
  // Synchronously hydrate from localStorage on first render so the sidebar
  // already reflects the subscribed feature set — no flash of hidden items.
  const [state, setState] = useState(() => {
    const cached = readCache(organization?.id);
    if (cached) return { ...cached, loading: false };
    return emptyState();
  });

  const load = async () => {
    if (!organization?.id) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }

    // Two parallel queries: subscription metadata (existing view) + effective
    // features (new RPC). On trial, every feature is unlocked for evaluation.
    const [{ data: metaRow }, { data: featuresRaw }] = await Promise.all([
      supabase
        .from('organizations_with_features')
        .select('em_active, em_subscribed, em_subscribed_since, subscription_status, trial_ends_at')
        .eq('id', organization.id)
        .maybeSingle(),
      supabase.rpc('org_effective_features', { p_org_id: organization.id }),
    ]);

    const sub = metaRow?.subscription_status ?? 'trial';
    const onTrial = sub === 'trial';
    const features = expandFeatures(featuresRaw as string[] | null);

    // Plan-scoped gating: trust org_effective_features() exclusively. That
    // RPC already handles trials (it returns the trial_plan_code's features,
    // or the full set when a super admin has granted trial_full_access).
    // We used to OR `onTrial` here, which silently unlocked every feature
    // for every trial customer and broke the entire plan-scoped model.
    const has = (code: FeatureCode) => features.has(code);

    // Legacy EM customers (e.g. `em-unlimited` plan, `growth-25`) don't have
    // the new `employee_management` code in features_included — they were
    // gated through `organizations.em_subscribed` instead. Honour that.
    const legacyEm = !!metaRow?.em_active;

    const next: Cached = {
      monitoring_basic_enabled: has('monitoring_basic'),
      screenshots_enabled: has('screenshots'),
      videos_enabled: has('videos'),
      live_enabled: has('live'),
      remote_enabled: has('remote'),
      dlp_enabled: has('dlp'),
      em_enabled: has('employee_management') || legacyEm,

      em_active: !!metaRow?.em_active,
      em_subscribed: !!metaRow?.em_subscribed,
      em_subscribed_since: metaRow?.em_subscribed_since ?? null,

      subscription_status: sub,
      trial_ends_at: metaRow?.trial_ends_at ?? '',
      on_trial: onTrial,

      loading: false,
    };
    setState(next);
    writeCache(organization.id, next);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [organization?.id]);

  return { ...state, refresh: load };
}
