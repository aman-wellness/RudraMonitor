import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useAppRole } from '@/lib/useAppRole';
import { supabase } from '@/lib/supabase';

export default function PostLogin() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { role, loading: roleLoading } = useAppRole();

  useEffect(() => {
    if (authLoading || roleLoading) return;
    if (!user) { navigate('/login', { replace: true }); return; }

    // Routing priority:
    //   1. Partner → partner portal (partners never have their own org).
    //   2. If the user owns / belongs to an org → customer dashboard.
    //      Super-admins who ALSO have an org get the customer dashboard;
    //      they reach the admin portal via the explicit /super entry or
    //      the "Super Admin" link in the sidebar.
    //   3. Super-admin (no org) → admin dashboard.
    //   4. No org, no role → complete-signup.
    if (role === 'partner') { navigate('/partner/dashboard', { replace: true }); return; }

    (async () => {
      const { data: ownsOrg } = await supabase
        .from('organizations').select('id').eq('owner_user_id', user.id).maybeSingle();
      if (ownsOrg) { navigate('/dashboard', { replace: true }); return; }
      const { data: member } = await supabase
        .from('org_members').select('org_id').eq('user_id', user.id).maybeSingle();
      if (member) { navigate('/dashboard', { replace: true }); return; }
      if (role === 'super_admin') { navigate('/admin/dashboard', { replace: true }); return; }
      navigate('/complete-signup', { replace: true });
    })();
  }, [authLoading, roleLoading, user, role, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-950 text-gray-500 text-sm">
      Routing…
    </div>
  );
}
