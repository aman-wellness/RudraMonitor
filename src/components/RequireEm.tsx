// Gate every /employees/* route behind the Employee Management subscription.
// Trial orgs pass through (so signups can evaluate); paid orgs need
// em_subscribed = true to access. Otherwise we render an upgrade CTA instead
// of the underlying page.

import { Link } from 'react-router-dom';
import { useFeatures } from '@/lib/useFeatures';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import type { ReactNode } from 'react';

export default function RequireEm({ children }: { children: ReactNode }) {
  const { em_enabled, em_subscribed, subscription_status, trial_ends_at, loading } = useFeatures();

  if (loading) {
    return (
      <DashboardLayout>
        <div className="text-sm text-gray-500 p-6">Loading subscription…</div>
      </DashboardLayout>
    );
  }

  if (em_enabled) {
    return <>{children}</>;
  }

  return (
    <DashboardLayout>
      <div className="max-w-2xl mx-auto mt-10">
        <div className="bg-gradient-to-br from-emerald-500/10 to-blue-500/10 border border-emerald-500/30 rounded-2xl p-8">
          <div className="flex items-center gap-3 mb-3">
            <span className="w-12 h-12 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <i className="ri-team-line text-2xl" />
            </span>
            <div>
              <p className="text-xs text-emerald-400 uppercase tracking-wider">Add-on required</p>
              <h1 className="text-2xl font-poppins font-semibold text-white">Employee Management</h1>
            </div>
          </div>

          <p className="text-sm text-gray-300 mb-5 leading-relaxed">
            Provision M365 / Google users, manage groups & teams, run the credentials vault,
            track IT hardware, and orchestrate offboarding — all from one place.
          </p>

          <ul className="text-sm text-gray-300 space-y-1.5 mb-6">
            <li>✓ Microsoft 365 + Google Workspace two-way sync</li>
            <li>✓ Unlimited users, departments, managers</li>
            <li>✓ Credentials vault with self-service request workflow</li>
            <li>✓ IT hardware inventory with offboarding auto-unassign</li>
            <li>✓ Per-platform invoice tracking (Stripe + Razorpay sync)</li>
          </ul>

          <div className="bg-dark-900/60 border border-dark-700 rounded-lg p-4 mb-5">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-white">$100</span>
              <span className="text-sm text-gray-400">/ month, unlimited users</span>
            </div>
            {subscription_status === 'trial' && trial_ends_at && (
              <p className="text-xs text-amber-300 mt-1">
                Your trial ended {new Date(trial_ends_at).toLocaleDateString()}. Upgrade to keep this module.
              </p>
            )}
            {em_subscribed === false && subscription_status === 'active' && (
              <p className="text-xs text-gray-400 mt-1">
                Add this as an add-on to your existing plan.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Link to="/subscription" className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm text-white font-medium">
              Enable Employee Management
            </Link>
            <Link to="/dashboard" className="px-5 py-2.5 bg-dark-700 hover:bg-dark-600 rounded-lg text-sm text-white">
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
