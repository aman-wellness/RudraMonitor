import { useEffect, useState } from 'react';
import { supabase, type AppRole } from './supabase';
import { useAuth } from '@/context/AuthContext';

export type AppRoleState = {
  role: AppRole | null;
  partnerId: string | null;
  loading: boolean;
};

export function useAppRole(): AppRoleState {
  const { user } = useAuth();
  const [state, setState] = useState<AppRoleState>({ role: null, partnerId: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setState({ role: null, partnerId: null, loading: false });
      return;
    }
    (async () => {
      const { data } = await supabase
        .from('app_users')
        .select('app_role,partner_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      setState({
        role: (data?.app_role as AppRole) ?? 'customer',
        partnerId: (data?.partner_id as string | null) ?? null,
        loading: false,
      });
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  return state;
}
