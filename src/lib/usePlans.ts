// Live-pricing hook. Reads active `plans` rows from the DB so any
// super-admin edit (Plans Editor at /admin/plans) propagates to the
// landing page + /subscription + /admin-portal Billing tab on next
// fetch.
//
// We keep a hardcoded HARDCODED_DEFAULTS object as a fallback for the
// first paint and the offline / no-DB case (e.g. landing-page rendering
// while the Supabase request is in flight). When the live data arrives,
// the hook patches it in.
//
// PlanGrid renders the SAME canonical 4-tier layout regardless of what
// the DB contains — the DB only controls the prices, names, and
// `features_included` list. New tiers in DB are simply not surfaced
// (yet) — that's a deliberate constraint because the UI is shaped
// around exactly Starter / Professional / EM standalone / Enterprise.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface LivePlan {
  code: string;
  name: string;
  price_inr: number;
  price_usd: number;
  billing_cycle: 'monthly' | 'yearly';
  features_included: string[];
  is_addon: boolean;
  is_em_standalone: boolean;
}

export function usePlans() {
  const [plans, setPlans] = useState<LivePlan[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('plans')
      .select('code, name, price_inr, price_usd, billing_cycle, features_included, is_addon, is_em_standalone')
      .eq('is_active', true)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.warn('usePlans: failed to load plans, using hardcoded fallback', error);
          setLoaded(true);
          return;
        }
        setPlans(
          (data ?? []).map((p) => ({
            code: String(p.code),
            name: String(p.name),
            price_inr: Number(p.price_inr),
            price_usd: Number(p.price_usd ?? 0),
            billing_cycle: (p.billing_cycle === 'yearly' ? 'yearly' : 'monthly') as 'monthly' | 'yearly',
            features_included: Array.isArray(p.features_included) ? p.features_included : [],
            is_addon: !!p.is_addon,
            is_em_standalone: !!p.is_em_standalone,
          })),
        );
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  // Lookup by SKU. Returns undefined when the row isn't found, so callers
  // can fall back to a hardcoded default.
  const byCode = (code: string): LivePlan | undefined => plans.find((p) => p.code === code);

  return { plans, byCode, loaded };
}
