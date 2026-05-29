// Per-user access gate (paired with RequireFeature for org-level
// subscription gating). RequireFeature answers "did the org buy this
// module?"; RequireAccess answers "did the admin grant THIS user that
// module?". A page renders only when both pass.
//
// Wraps each gated route in router/config.tsx. Owners + admins always
// pass — see useAppAccess for the unrestricted check.

import type { ReactNode } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAppAccess, APP_ACCESS_CODES, type AppAccessCode } from '@/lib/useAppAccess';

export default function RequireAccess({ code, children }: { code: AppAccessCode; children: ReactNode }) {
  const a = useAppAccess();
  if (a.loading) {
    // Don't speculatively render the children — see RequireFeature for
    // the same reasoning. Brief blank page beats leaking the module
    // name to a user who shouldn't reach it.
    return (
      <DashboardLayout>
        <div className="p-6" />
      </DashboardLayout>
    );
  }
  if (a.unrestricted || a.allowed.has(code)) {
    return <>{children}</>;
  }
  const def = APP_ACCESS_CODES.find((c) => c.code === code);
  return (
    <DashboardLayout>
      <div className="max-w-md mx-auto mt-16 bg-dark-800 border border-dark-700 rounded-xl p-6 text-center">
        <i className="ri-lock-line text-4xl text-amber-400 mb-3" />
        <h1 className="text-lg font-semibold text-white mb-1">Access restricted</h1>
        <p className="text-sm text-gray-400 mb-3">
          You don&apos;t have access to <strong className="text-white">{def?.label ?? code}</strong>.
          Ask an org admin to add it to your account from Admin Portal → Users.
        </p>
      </div>
    </DashboardLayout>
  );
}
