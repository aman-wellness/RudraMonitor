// Pricing cards for the public marketing /pricing page.
//
// Rows live in public.site_plans (migration 0153) and are managed from the
// super-admin portal (/admin/plans → "Website pricing cards"). RLS exposes
// is_active rows to anon, so the unauthenticated marketing page reads them
// with the normal browser client — no edge function needed.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface SitePlan {
  id: string;
  name: string;
  tagline: string | null;
  price_monthly: number | null;
  price_yearly: number | null;
  custom_price_label: string | null;
  currency_symbol: string;
  price_note: string;
  features: string[];
  accent: string;
  icon: 'rocket' | 'chart' | 'building';
  badge: string | null;
  cta_label: string;
  cta_href: string;
  display_order: number;
  is_active: boolean;
}

// Mirrors the 0153 seed. Rendered until the fetch resolves and kept when the
// query errors or returns nothing (e.g. migration not applied yet), so the
// pricing page never shows an empty plans grid.
export const FALLBACK_SITE_PLANS: SitePlan[] = [
  {
    id: 'fallback-starter', name: 'Starter',
    tagline: 'For small teams getting started with visibility.',
    price_monthly: 199, price_yearly: 159, custom_price_label: null,
    currency_symbol: '₹', price_note: '/ user / month',
    features: ['Activity & time tracking', 'App & website usage', 'Productivity insights', 'Basic reports'],
    accent: '#0D9488', icon: 'rocket', badge: null,
    cta_label: 'Start free trial', cta_href: '/signup', display_order: 1, is_active: true,
  },
  {
    id: 'fallback-professional', name: 'Professional',
    tagline: 'For teams that need deeper visibility.',
    price_monthly: 299, price_yearly: 239, custom_price_label: null,
    currency_symbol: '₹', price_note: '/ user / month',
    features: ['Everything in Starter', 'Screenshots', 'Live screen view', 'Advanced productivity analytics', 'DLP & security alerts', 'Advanced reports'],
    accent: '#0D9488', icon: 'chart', badge: 'MOST POPULAR',
    cta_label: 'Start free trial', cta_href: '/signup', display_order: 2, is_active: true,
  },
  {
    id: 'fallback-enterprise', name: 'Enterprise',
    tagline: 'For organizations with advanced requirements.',
    price_monthly: null, price_yearly: null, custom_price_label: 'Custom pricing',
    currency_symbol: '₹', price_note: '/ user / month',
    features: ['Everything in Professional', 'Advanced DLP', 'SSO & permissions', 'Custom data retention', 'Dedicated support', 'Custom deployment'],
    accent: '#7C3AED', icon: 'building', badge: null,
    cta_label: 'Talk to sales', cta_href: '/contact', display_order: 3, is_active: true,
  },
];

export function useSitePlans(): SitePlan[] {
  const [plans, setPlans] = useState<SitePlan[]>(FALLBACK_SITE_PLANS);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from('site_plans')
        .select('*')
        .eq('is_active', true)
        .order('display_order');
      if (!alive || error || !data || data.length === 0) return;
      setPlans(data as SitePlan[]);
    })();
    return () => { alive = false; };
  }, []);

  return plans;
}
