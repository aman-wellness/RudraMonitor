// Subscription overview — owner-only. Shows current plan, trial status,
// and the Employee Management toggle. Razorpay-billed upgrades land in a
// follow-up; for now the EM toggle flips the org flag immediately so admins
// can test feature gating before the live payment flow is wired.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';
import { useFeatures } from '@/lib/useFeatures';
import { useAuth } from '@/context/AuthContext';

export default function SubscriptionPage() {
  const { organization } = useAuth();
  const features = useFeatures();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleEm = async (action: 'enable_em' | 'disable_em') => {
    if (action === 'disable_em' && !confirm('Disable Employee Management? You can re-enable anytime.')) return;
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/org-subscription-update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      await features.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const trialDaysLeft = (() => {
    if (features.subscription_status !== 'trial' || !features.trial_ends_at) return null;
    const diff = new Date(features.trial_ends_at).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86_400_000));
  })();

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">Subscription</h1>
          <p className="text-sm text-gray-400">Manage your plan and add-ons.</p>
        </header>

        {err && <div className="mb-4 px-3 py-2 rounded-lg text-sm bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

        {/* Current plan */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 mb-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-400 uppercase tracking-wider">Current plan</p>
            <StatusPill status={features.subscription_status} />
          </div>
          <p className="text-xl text-white font-semibold">{organization?.name ?? '—'}</p>
          {features.subscription_status === 'trial' && trialDaysLeft !== null && (
            <p className="text-sm text-amber-300 mt-1">
              {trialDaysLeft > 0
                ? `${trialDaysLeft} days left in trial — all modules active until ${new Date(features.trial_ends_at).toLocaleDateString()}.`
                : `Trial ended ${new Date(features.trial_ends_at).toLocaleDateString()}. Subscribe to keep using add-ons.`}
            </p>
          )}
        </div>

        {/* Employee Management add-on */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
          <div className="flex items-start gap-4">
            <span className="w-12 h-12 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center flex-shrink-0">
              <i className="ri-team-line text-2xl" />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-lg text-white font-semibold">Employee Management</h2>
                {features.em_subscribed ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">subscribed</span>
                ) : features.em_active ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">trial</span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/15 text-gray-400">not active</span>
                )}
              </div>
              <p className="text-sm text-gray-400 mb-3">
                Provisioning, M365/Google sync, groups, credentials vault, IT hardware, offboarding.
              </p>

              <div className="grid grid-cols-2 gap-3 mb-4 text-xs text-gray-300">
                <Bullet>M365 & Google Workspace two-way sync</Bullet>
                <Bullet>Unlimited users + managers</Bullet>
                <Bullet>Credentials vault + self-service requests</Bullet>
                <Bullet>IT hardware inventory + auto-unassign</Bullet>
                <Bullet>3-stage offboarding pipeline</Bullet>
                <Bullet>Invoice tracking (Stripe + Razorpay sync)</Bullet>
              </div>

              <div className="bg-dark-900/60 border border-dark-700 rounded-lg p-3 mb-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white">$100</span>
                  <span className="text-xs text-gray-400">/ month · unlimited users</span>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Add-on to any existing plan. Billed separately.
                </p>
              </div>

              {features.em_subscribed ? (
                <div className="flex items-center gap-3">
                  <p className="text-xs text-gray-400">
                    Active since {features.em_subscribed_since ? new Date(features.em_subscribed_since).toLocaleDateString() : 'recently'}.
                  </p>
                  <button
                    onClick={() => toggleEm('disable_em')}
                    disabled={busy}
                    className="ml-auto px-3 py-1.5 bg-dark-700 hover:bg-dark-600 disabled:opacity-50 rounded-lg text-xs text-rose-400"
                  >
                    Cancel add-on
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => toggleEm('enable_em')}
                  disabled={busy}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium"
                >
                  {busy ? 'Enabling…' : 'Enable Employee Management — $100/mo'}
                </button>
              )}

              {features.em_active && (
                <div className="mt-3 pt-3 border-t border-dark-700">
                  <Link to="/employees" className="text-xs text-emerald-400 hover:text-emerald-300">
                    Go to Employees →
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>

        <p className="mt-5 text-[11px] text-gray-500">
          Live Razorpay billing for upgrades/downgrades is rolling out. For now the toggle flips the entitlement flag immediately — your team accountant will receive a manual invoice for $100/mo as long as the add-on is active.
        </p>
      </div>
    </DashboardLayout>
  );
}

function StatusPill({ status }: { status: string }) {
  const tint: Record<string, string> = {
    active:  'bg-emerald-500/15 text-emerald-400',
    trial:   'bg-amber-500/15 text-amber-400',
    expired: 'bg-rose-500/15 text-rose-400',
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${tint[status] ?? 'bg-dark-700 text-gray-400'}`}>{status}</span>;
}
function Bullet({ children }: { children: React.ReactNode }) {
  return <p>✓ {children}</p>;
}
