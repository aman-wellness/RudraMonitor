import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/lib/useFeatures';
import { supabase } from '@/lib/supabase';
import { startSubscriptionCheckout } from '@/lib/razorpay';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';

/**
 * /checkout?plan=pro-m&addons=dlp-addon-m,em-addon-m&currency=inr
 *
 * Drives the paid-upgrade Razorpay flow. Each operation (main plan switch
 * and each add-on activation) is its own Razorpay Subscription, opened in
 * Razorpay Checkout one after the other so the customer enters their card
 * once per item. After each successful payment, the webhook fires
 * server-side and the next item opens. Final step polls until the
 * org_effective_features RPC reflects the change, then routes back to
 * /subscription.
 */

type Step = {
  kind: 'plan' | 'addon' | 'trial_switch';
  plan_code: string;
};

export default function Checkout() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user, organization, refreshOrganization } = useAuth();
  const features = useFeatures();
  const onTrial = features.on_trial;

  const planCode    = params.get('plan');
  const addonsParam = params.get('addons');
  const currency    = (params.get('currency') ?? 'inr').toUpperCase() as 'INR' | 'USD';
  const seats       = Math.max(1, Number(params.get('seats') ?? '5') || 5);

  // Build the ordered list of operations to run. Main plan first (if any),
  // then add-ons. We skip the plan step when caller already has it.
  const steps = useMemo<Step[]>(() => {
    const list: Step[] = [];
    if (planCode && planCode !== 'enterprise') {
      // Trial customers switching to a different plan get the ₹2-verify
      // flow ('trial_switch') instead of a full-price charge.
      list.push({ kind: onTrial ? 'trial_switch' : 'plan', plan_code: planCode });
    }
    if (addonsParam) {
      addonsParam.split(',').map((s) => s.trim()).filter(Boolean).forEach((code) => {
        list.push({ kind: 'addon', plan_code: code });
      });
    }
    return list;
  }, [planCode, addonsParam, onTrial]);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [waitingForWebhook, setWaitingForWebhook] = useState(false);

  // After each Checkout fires, the webhook updates the org server-side. Poll
  // org_effective_features until the change is reflected, then advance to
  // the next step (or finish).
  useEffect(() => {
    if (!waitingForWebhook || !organization?.id) return;
    let cancelled = false;
    const step = steps[currentIdx];
    if (!step) return;

    const featureExpected = (): string | null => {
      // For plan switches: we just want subscription_status flipping to 'active'.
      // For add-ons: the addon's feature(s) should appear in org_effective_features.
      const featureByAddon: Record<string, string> = {
        'dlp-addon-m': 'dlp',
        'dlp-addon-y': 'dlp',
        'em-addon-m':  'employee_management',
        'em-addon-y':  'employee_management',
      };
      if (step.kind === 'addon') return featureByAddon[step.plan_code] ?? null;
      return null;
    };

    (async () => {
      // Tight 800 ms poll for the first 10 ticks (~8 s) — Razorpay usually
      // fires the webhook within a couple of seconds, so be ready. After that
      // taper to 2 s for another 20 ticks (~40 s) for slow networks.
      for (let i = 0; i < 30 && !cancelled; i++) {
        if (step.kind === 'plan') {
          const { data: org } = await supabase
            .from('organizations').select('subscription_status').eq('id', organization.id).maybeSingle();
          if (org?.subscription_status === 'active') break;
        } else if (step.kind === 'trial_switch') {
          const { data: org } = await supabase
            .from('organizations').select('trial_plan_code').eq('id', organization.id).maybeSingle();
          if (org?.trial_plan_code === step.plan_code) break;
        } else {
          // Add-on activation: check org_addons table directly — it's the
          // authoritative table the webhook writes to. Don't rely on
          // org_effective_features, which has different semantics during a
          // trial (returns only trial-plan features, not add-ons).
          const { data: row } = await supabase
            .from('org_addons')
            .select('id, active, plans!inner(code)')
            .eq('org_id', organization.id)
            .eq('active', true)
            .eq('plans.code', step.plan_code)
            .maybeSingle();
          if (row) break;
        }
        await new Promise((r) => setTimeout(r, i < 10 ? 800 : 2000));
      }
      if (cancelled) return;

      await refreshOrganization();
      // Bust feature cache so sidebar reflects new entitlements immediately.
      if (organization?.id) {
        try { window.localStorage.removeItem(`rudrans:features:v2:${organization.id}`); } catch { /* ignore */ }
      }

      const next = currentIdx + 1;
      if (next >= steps.length) {
        navigate('/subscription?upgrade=success', { replace: true });
        return;
      }
      setCurrentIdx(next);
      setWaitingForWebhook(false);
    })();

    return () => { cancelled = true; };
  }, [waitingForWebhook, currentIdx, steps, organization?.id, navigate, refreshOrganization]);

  const startStep = async (step: Step) => {
    setError(null);
    setOpening(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in.');

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-create-upgrade`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ kind: step.kind, plan_code: step.plan_code, currency, seats }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Upgrade create failed');

      await startSubscriptionCheckout({
        keyId:          body.key_id,
        subscriptionId: body.subscription_id,
        customerName:   organization?.name ?? user?.email ?? '',
        customerEmail:  user?.email ?? '',
        customerPhone:  null,
        amountLabel:    body.plan_price_label,
        onSuccess: (resp) => {
          // Don't wait for the webhook — finalize INSTANTLY using the
          // signature Razorpay just handed back. Sub-second on the happy
          // path. The webhook still fires as a redundant safety net (RPCs
          // are idempotent).
          setOpening(false);
          setWaitingForWebhook(true);
          void (async () => {
            try {
              const verifyUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-verify-upgrade`;
              const r = await fetch(verifyUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
                  Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({
                  subscription_id:     resp.razorpay_subscription_id,
                  razorpay_payment_id: resp.razorpay_payment_id,
                  razorpay_signature:  resp.razorpay_signature,
                }),
              });
              const j = await r.json();
              if (j.fatal) {
                setError(j.error ?? 'Verification failed.');
                setWaitingForWebhook(false);
                return;
              }
              // Success OR transient error — the poll-loop below
              // (waitingForWebhook=true) will pick it up either way.
            } catch {
              // Network blip — webhook safety net will catch it.
            }
          })();
        },
        onDismiss: () => {
          setError('Payment cancelled. Your plan has not been changed yet.');
          setOpening(false);
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upgrade failed');
      setOpening(false);
    }
  };

  // Empty / invalid URL → bounce back.
  if (steps.length === 0) {
    return (
      <DashboardLayout>
        <div className="max-w-md mx-auto bg-dark-800 border border-dark-700 rounded-2xl p-6 mt-12 text-center">
          <p className="text-sm text-gray-400 mb-3">No plan or add-on selected.</p>
          <Link to="/subscription" className="text-sm text-emerald-400 hover:text-emerald-300">Back to Plans</Link>
        </div>
      </DashboardLayout>
    );
  }

  const step = steps[currentIdx];
  const stepLabel = (s: Step) => {
    const planName = s.plan_code.startsWith('pro')
      ? 'Professional'
      : s.plan_code.startsWith('starter')
      ? 'Starter'
      : s.plan_code.startsWith('em-addon')
      ? 'Employee Management Add-on'
      : s.plan_code.startsWith('em')
      ? 'Employee Management'
      : s.plan_code.startsWith('dlp')
      ? 'DLP Add-on'
      : s.plan_code;
    const cycle = s.plan_code.endsWith('-y') ? 'yearly' : 'monthly';
    if (s.kind === 'plan') return `Switch to ${planName} (${cycle})`;
    if (s.kind === 'trial_switch') return `Trial switch to ${planName} — ₹2 card verification`;
    return `Activate ${planName}`;
  };

  return (
    <DashboardLayout>
      <div className="max-w-xl mx-auto bg-dark-800 border border-dark-700 rounded-2xl p-6 mt-12">
        <h1 className="text-xl font-semibold text-white mb-1">Checkout</h1>
        <p className="text-xs text-gray-500 mb-1">
          Each item below opens Razorpay Checkout once. Your card is charged immediately on authentication — no separate trial period.
        </p>
        <p className="text-xs text-emerald-400 mb-6">
          Billing for <strong>{seats}</strong> seat{seats === 1 ? '' : 's'}.
        </p>

        <ol className="space-y-2 mb-6">
          {steps.map((s, i) => {
            const status: 'done' | 'current' | 'pending' = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'pending';
            return (
              <li key={`${s.kind}-${s.plan_code}`} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${
                status === 'done' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : status === 'current' ? 'bg-dark-900 border-emerald-500/40 text-white'
                : 'bg-dark-900/50 border-dark-700 text-gray-500'
              }`}>
                <span className="w-5 h-5 rounded-full bg-dark-700 text-[10px] flex items-center justify-center">
                  {status === 'done' ? '✓' : i + 1}
                </span>
                <span className="text-sm flex-1">{stepLabel(s)}</span>
                <span className="text-[10px] uppercase tracking-wider opacity-60">{status}</span>
              </li>
            );
          })}
        </ol>

        {waitingForWebhook && (
          <div className="text-center py-4">
            <div className="w-10 h-10 rounded-full bg-emerald-500/15 border border-emerald-500/40 mx-auto mb-2 flex items-center justify-center">
              <i className="ri-loader-4-line text-xl text-emerald-400 animate-spin" />
            </div>
            <p className="text-sm text-white">Payment received — applying upgrade…</p>
            <p className="text-xs text-gray-500 mt-1">5-15 seconds. Hang tight.</p>
          </div>
        )}

        {!waitingForWebhook && step && (
          <>
            {error && (
              <div className="mb-4 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>
            )}
            <button
              type="button"
              onClick={() => startStep(step)}
              disabled={opening}
              className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-dark-950 font-medium py-2.5 rounded-lg"
            >
              {opening
                ? 'Opening Razorpay…'
                : step.kind === 'plan' ? 'Pay & switch plan'
                : step.kind === 'trial_switch' ? 'Verify ₹2 & switch trial plan'
                : 'Pay & activate add-on'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/subscription')}
              className="w-full mt-2 text-xs text-gray-500 hover:text-gray-300"
            >
              Cancel and go back
            </button>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
