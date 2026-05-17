// Hook: returns the caller's role inside their org (owner / admin / viewer)
// plus convenience booleans. Components use this to hide write controls when
// the user is a viewer — DB RLS also blocks writes server-side, but disabling
// the buttons in the UI gives a cleaner experience.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

export type OrgRole = 'owner' | 'admin' | 'viewer' | null;

export function useOrgRole() {
  const { user, organization } = useAuth();
  const [role, setRole] = useState<OrgRole>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id || !organization?.id) {
      setRole(null);
      setLoading(false);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from('org_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('org_id', organization.id)
        .maybeSingle();
      setRole(((data?.role as OrgRole) ?? null));
      setLoading(false);
    })();
  }, [user?.id, organization?.id]);

  const canWrite = role === 'owner' || role === 'admin';
  const isViewer = role === 'viewer';

  return { role, canWrite, isViewer, loading };
}
