// Subscription overview — signed-in customer view. Same UI as the landing
// page (via the shared <PlanGrid />), plus a header banner showing the
// current plan + trial countdown.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { supabase } from '@/lib/supabase';
import { useFeatures } from '@/lib/useFeatures';
import { useAuth } from '@/context/AuthContext';
import PlanGrid, { type Currency } from '@/components/PlanGrid';

export default function SubscriptionPage() {
  const { organization } = useAuth();
  const features = useFeatures();
  const navigate = useNavigate();

  // Look up the org's CURRENT plan code so PlanGrid can badge the right
  // card. Joins licenses → plans for the most-recent active license.
  const [currentPlanCode, setCurrentPlanCode] = useState<string | null>(null);
  useEffect(() => {
    if (!organization?.id) return;
    let cancelled = false;
    supabase
      .from('licenses')
      .select('plans(code)')
      .eq('organization_id', organization.id)
      .eq('status', 'active')
      .order('issued_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        // PostgREST join returns plans as either an object or an array
        // depending on the relationship cardinality inferred by the
        // schema cache. Accept both shapes.
        const row = data as { plans?: { code?: string } | { code?: string }[] | null } | null;
        const plans = row?.plans;
        const code = Array.isArray(plans) ? plans[0]?.code : plans?.code;
        setCurrentPlanCode(code ?? null);
      });
    return () => { cancelled = true; };
  }, [organization?.id]);

  // Default INR for Indian customers; USD otherwise. country_code lives on
  // the org row but isn't on the typed shape — read defensively.
  const country = String((organization as { country_code?: string } | null)?.country_code ?? '').toUpperCase();
  const defaultCurrency: Currency = country === 'IN' ? 'INR' : 'USD';

  const trialDaysLeft = (() => {
    if (features.subscription_status !== 'trial' || !features.trial_ends_at) return null;
    const diff = new Date(features.trial_ends_at).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86_400_000));
  })();

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">Subscription</h1>
          <p className="text-sm text-gray-400">Manage your plan and add-ons.</p>
        </header>

        {/* Current status banner */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 mb-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">Current plan</p>
              <p className="text-xl text-white font-semibold mt-1">{organization?.name ?? '—'}</p>
              {features.subscription_status === 'trial' && trialDaysLeft !== null && (
                <p className="text-sm text-amber-300 mt-1">
                  {trialDaysLeft > 0
                    ? `${trialDaysLeft} days left in trial — all modules active until ${new Date(features.trial_ends_at).toLocaleDateString()}.`
                    : `Trial ended ${new Date(features.trial_ends_at).toLocaleDateString()}.`}
                </p>
              )}
            </div>
            <StatusPill status={features.subscription_status} />
          </div>
        </div>

        <PlanGrid
          currentPlanCode={currentPlanCode}
          defaultCurrency={defaultCurrency}
          onSelect={({ planCode, seats, addons, currency }) => {
            if (planCode === 'enterprise') {
              navigate('/#contact');
              return;
            }
            const qs = new URLSearchParams({
              plan: planCode,
              seats: String(seats),
              currency: currency.toLowerCase(),
              ...(addons.length ? { addons: addons.join(',') } : {}),
            });
            navigate(`/checkout?${qs.toString()}`);
          }}
        />

        <p className="mt-8 text-center text-[11px] text-gray-500 max-w-3xl mx-auto leading-relaxed">
          Razorpay billing for the v2 plans is rolling out. Click <strong>Switch</strong> to be redirected
          to the secure checkout flow with your selected plan, seat count and add-ons pre-filled.
        </p>
      </div>
    </DashboardLayout>
  );
}

function StatusPill({ status }: { status: string }) {
  const tint: Record<string, string> = {
    active:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    trial:   'bg-amber-500/15 text-amber-400 border-amber-500/30',
    expired: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  };
  return <span className={`text-xs px-3 py-1 rounded-full border ${tint[status] ?? 'bg-dark-700 text-gray-400 border-dark-600'}`}>{status}</span>;
}
