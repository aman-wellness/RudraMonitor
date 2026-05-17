// Feature-flag hooks driven by the per-org subscription state.
//
// Trial orgs see everything by default (so they can evaluate). Paid orgs only
// see modules they've subscribed to. The Employee Management suite is gated
// behind `em_active`: true when the org is in trial OR has em_subscribed=true.
//
// Reads from the `organizations_with_features` view (migration 0045), which
// computes em_active server-side so the trial-vs-now check is consistent.

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

export type OrgFeatures = {
  em_active: boolean;
  em_subscribed: boolean;
  em_subscribed_since: string | null;
  subscription_status: string;
  trial_ends_at: string;
  loading: boolean;
  refresh: () => Promise<void>;
};

export function useFeatures(): OrgFeatures {
  const { organization } = useAuth();
  const [state, setState] = useState({
    em_active: false,
    em_subscribed: false,
    em_subscribed_since: null as string | null,
    subscription_status: 'trial',
    trial_ends_at: '',
    loading: true,
  });

  const load = async () => {
    if (!organization?.id) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    const { data } = await supabase
      .from('organizations_with_features')
      .select('em_active, em_subscribed, em_subscribed_since, subscription_status, trial_ends_at')
      .eq('id', organization.id)
      .maybeSingle();
    setState({
      em_active: !!data?.em_active,
      em_subscribed: !!data?.em_subscribed,
      em_subscribed_since: data?.em_subscribed_since ?? null,
      subscription_status: data?.subscription_status ?? 'trial',
      trial_ends_at: data?.trial_ends_at ?? '',
      loading: false,
    });
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [organization?.id]);

  return { ...state, refresh: load };
}
