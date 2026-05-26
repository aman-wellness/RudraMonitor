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

type TrialReq = { id: string; status: 'pending' | 'approved' | 'denied' | 'cancelled'; requested_at: string; decision_note: string | null };

export default function SubscriptionPage() {
  const { organization } = useAuth();
  const features = useFeatures();
  const navigate = useNavigate();

  const [trialFullAccess, setTrialFullAccess] = useState(false);
  const [trialPlanCode, setTrialPlanCode] = useState<string | null>(null);
  const [latestReq, setLatestReq] = useState<TrialReq | null>(null);
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);
  const [reqReason, setReqReason] = useState('');

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

  // Trial gating state: which plan the trial covers + whether super admin
  // has already granted full-features access, plus the latest extension
  // request so we can show pending/denied state.
  useEffect(() => {
    if (!organization?.id) return;
    let cancelled = false;
    (async () => {
      const { data: org } = await supabase
        .from('organizations')
        .select('trial_plan_code, trial_full_access')
        .eq('id', organization.id)
        .maybeSingle();
      if (cancelled) return;
      setTrialPlanCode(org?.trial_plan_code ?? null);
      setTrialFullAccess(!!org?.trial_full_access);

      const { data: req } = await supabase
        .from('trial_extension_requests')
        .select('id, status, requested_at, decision_note')
        .eq('org_id', organization.id)
        .order('requested_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setLatestReq((req as TrialReq | null) ?? null);
    })();
    return () => { cancelled = true; };
  }, [organization?.id]);

  const requestFullTrial = async () => {
    setReqError(null);
    setReqSubmitting(true);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trial-extension-request`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: reqReason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Request failed');
      setLatestReq(body.request as TrialReq);
      setReqReason('');
    } catch (err) {
      setReqError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setReqSubmitting(false);
    }
  };

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
                    ? trialFullAccess
                      ? `${trialDaysLeft} days left — full-features trial active (approved by admin) until ${new Date(features.trial_ends_at).toLocaleDateString()}.`
                      : `${trialDaysLeft} days left in your ${planLabel(trialPlanCode)} trial — only ${planLabel(trialPlanCode)} features are unlocked. Trial ends ${new Date(features.trial_ends_at).toLocaleDateString()}.`
                    : `Trial ended ${new Date(features.trial_ends_at).toLocaleDateString()}.`}
                </p>
              )}
            </div>
            <StatusPill status={features.subscription_status} />
          </div>

          {/* Full-features trial request flow. Only relevant while on a
              plan-scoped trial and not already approved. */}
          {features.subscription_status === 'trial' && !trialFullAccess && (
            <div className="mt-4 pt-4 border-t border-dark-700">
              {latestReq?.status === 'pending' ? (
                <p className="text-sm text-amber-300">
                  <i className="ri-time-line mr-1" />
                  Full-features trial requested on {new Date(latestReq.requested_at).toLocaleDateString()} — awaiting super-admin review.
                </p>
              ) : latestReq?.status === 'denied' ? (
                <div className="text-sm text-rose-300">
                  <p><i className="ri-close-circle-line mr-1" />Previous request was denied{latestReq.decision_note ? ` (“${latestReq.decision_note}”)` : ''}. You may submit a new one with more context.</p>
                  <FullTrialRequestForm reason={reqReason} setReason={setReqReason} submitting={reqSubmitting} error={reqError} onSubmit={requestFullTrial} />
                </div>
              ) : (
                <FullTrialRequestForm reason={reqReason} setReason={setReqReason} submitting={reqSubmitting} error={reqError} onSubmit={requestFullTrial} />
              )}
            </div>
          )}
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

function planLabel(code: string | null): string {
  if (!code) return 'plan-scoped';
  if (code.startsWith('starter')) return 'Starter';
  if (code.startsWith('pro')) return 'Professional';
  if (code.startsWith('em')) return 'Employee Management';
  if (code.startsWith('dlp')) return 'DLP';
  return code;
}

function FullTrialRequestForm({
  reason, setReason, submitting, error, onSubmit,
}: {
  reason: string;
  setReason: (v: string) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
  return (
    <div>
      <p className="text-sm text-gray-300 mb-2">
        Need to evaluate every module (Live, Remote, DLP, Employee Management) during your trial? Request full-features access — a super admin will review.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why do you need full access? (optional)"
        rows={2}
        className="w-full text-sm bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
      />
      {error && <p className="text-xs text-rose-400 mt-1">{error}</p>}
      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting}
        className="mt-2 inline-flex items-center gap-2 text-sm bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg"
      >
        {submitting ? 'Submitting…' : 'Request full-features trial'}
      </button>
    </div>
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
