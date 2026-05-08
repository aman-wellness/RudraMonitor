import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useAppRole } from '@/lib/useAppRole';

export default function PostLogin() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { role, loading: roleLoading } = useAppRole();

  useEffect(() => {
    if (authLoading || roleLoading) return;
    if (!user) { navigate('/login', { replace: true }); return; }
    if (role === 'super_admin') navigate('/admin/dashboard', { replace: true });
    else if (role === 'partner') navigate('/partner/dashboard', { replace: true });
    else navigate('/dashboard', { replace: true });
  }, [authLoading, roleLoading, user, role]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-950 text-gray-500 text-sm">
      Routing…
    </div>
  );
}
