import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAppRole } from './useAppRole';
import { useAuth } from '@/context/AuthContext';
import type { AppRole } from './supabase';

function defaultPathFor(role: AppRole | null): string {
  if (role === 'super_admin') return '/admin/dashboard';
  if (role === 'partner') return '/partner/dashboard';
  return '/dashboard';
}

export function RequireRole({ allow, children }: { allow: AppRole[]; children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { role, loading: roleLoading } = useAppRole();

  if (authLoading || roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-950 text-gray-500 text-sm">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/auth/login" replace />;
  if (!role || !allow.includes(role)) {
    return <Navigate to={defaultPathFor(role)} replace />;
  }
  return <>{children}</>;
}

export const RequireSuperAdmin = ({ children }: { children: ReactNode }) =>
  <RequireRole allow={['super_admin']}>{children}</RequireRole>;

export const RequirePartner = ({ children }: { children: ReactNode }) =>
  <RequireRole allow={['partner']}>{children}</RequireRole>;

export const RequireCustomer = ({ children }: { children: ReactNode }) =>
  <RequireRole allow={['customer']}>{children}</RequireRole>;
