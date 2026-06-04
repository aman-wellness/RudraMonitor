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
    (async () => {
      // Real partner only — the app_users row must point at an ACTIVE
      // partner. Orphan rows (partner role + NULL partner_id) used to send
      // invited customers to /partner/dashboard. is_real_partner() is the
      // single source of truth (migration 0105).
      if (role === 'partner') {
        const { data: isReal } = await supabase.rpc('is_real_partner', { p_user_id: user.id });
        if (isReal === true) { navigate('/partner/dashboard', { replace: true }); return; }
        // Fall through — they'll be routed by org ownership / membership below.
      }

      const { data: ownsOrg } = await supabase
        .from('organizations').select('id').eq('owner_user_id', user.id).maybeSingle();
      if (ownsOrg) {
        try { sessionStorage.removeItem('we_oauth_intent'); } catch { /* ignore */ }
        navigate('/dashboard', { replace: true }); return;
      }

      // Defensive: bind any pending invites whose email matches this user.
      // The link_pending_org_member trigger handles this on user creation,
      // but if it raced / skipped (eg OAuth INSERT ordering), this RPC
      // recovers without a manual SQL fix.
      try { await supabase.rpc('link_my_pending_invites'); } catch { /* ignore */ }

      const { data: member } = await supabase
        .from('org_members').select('org_id').eq('user_id', user.id).maybeSingle();
      if (member) {
        try { sessionStorage.removeItem('we_oauth_intent'); } catch { /* ignore */ }
        navigate('/dashboard', { replace: true }); return;
      }
      if (role === 'super_admin') {
        try { sessionStorage.removeItem('we_oauth_intent'); } catch { /* ignore */ }
        navigate('/admin/dashboard', { replace: true }); return;
      }

      // No org, no membership, not a super-admin. If the user came via the
      // /login page (intent='login') they expected to sign INTO an existing
      // account — don't auto-create a trial; sign them out and surface a
      // clear error. If they came from /signup, fall through to the
      // ₹2-verify trial provisioning page.
      let intent: string | null = null;
      try { intent = sessionStorage.getItem('we_oauth_intent'); } catch { /* ignore */ }
      try { sessionStorage.removeItem('we_oauth_intent'); } catch { /* ignore */ }
      if (intent === 'login') {
        await supabase.auth.signOut();
        navigate('/login?error=no_account', { replace: true });
        return;
      }
      navigate('/complete-signup', { replace: true });
    })();
  }, [authLoading, roleLoading, user, role, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-950 text-gray-500 text-sm">
      Routing…
    </div>
  );
}
