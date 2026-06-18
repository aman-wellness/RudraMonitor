import { useEffect, useState } from 'react';
import { supabase } from './supabase';

// Global per-product feature flags managed by super admins. NOT billing
// gates (those live in `org_effective_features`). These are runtime
// switches for half-built / preview features that we don't want
// customers stumbling onto until they're production-ready.
//
// The values change rarely — once per release at most. We fetch once
// at mount and reuse the result. There's no realtime subscription
// because a stale flag is harmless (worst case: feature appears 1
// session late after toggle).

type FlagsMap = Record<string, boolean>;

let cached: FlagsMap | null = null;
let inflight: Promise<FlagsMap> | null = null;

async function fetchFlags(): Promise<FlagsMap> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = supabase
    .from('app_features')
    .select('code, enabled')
    .then(({ data, error }) => {
      inflight = null;
      if (error) {
        // Fail-open: if the query fails (network blip, RLS regression),
        // assume everything is enabled. We'd rather show the user a
        // half-built feature than hide a working one they paid for.
        cached = {};
        return cached;
      }
      const map: FlagsMap = {};
      for (const row of (data ?? []) as { code: string; enabled: boolean }[]) {
        map[row.code] = row.enabled;
      }
      cached = map;
      return cached;
    });
  return inflight;
}

/**
 * Read the global feature-flag map. Returns `{}` while loading; check
 * `loading` to gate UI off a "we don't know yet" decision.
 *
 * Usage in the sidebar / route gate:
 *   const { flags, loading } = useGlobalFeatureFlags();
 *   if (loading) return null;            // hide until known
 *   if (flags.auto_invoice === false) {  // hidden by super admin
 *     return null;
 *   }
 */
export function useGlobalFeatureFlags(): { flags: FlagsMap; loading: boolean } {
  const [flags, setFlags] = useState<FlagsMap>(() => cached ?? {});
  const [loading, setLoading] = useState(() => cached === null);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    fetchFlags().then((map) => {
      if (cancelled) return;
      setFlags(map);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return { flags, loading };
}

/** Force-refetch the flag map (called from super-admin UI after a toggle). */
export function invalidateFeatureFlagsCache(): void {
  cached = null;
  inflight = null;
}
