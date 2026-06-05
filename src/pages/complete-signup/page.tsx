import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { startSubscriptionCheckout } from '@/lib/razorpay';
import PhoneInput from '@/components/forms/PhoneInput';
import CountryStatePicker from '@/components/forms/CountryStatePicker';

/**
 * Shown right after an OAuth signup (Google / Microsoft) for users who don't
 * have an org yet. Same ₹2/$0.50 card-verification flow as the email signup —
 * the OAuth provider already verified the email, so no OTP is needed, but a
 * Razorpay subscription with a verification addon still has to be authorized
 * before the trial provisions. The webhook (`subscription.authenticated`)
 * creates the org + license against this user's existing auth row.
 */
export default function CompleteSignup() {
  const navigate = useNavigate();
  const { user, refreshOrganization } = useAuth();

  const [companyName, setCompanyName] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('IN'); // ISO2
  const [gstNumber, setGstNumber] = useState('');
  const [panNumber, setPanNumber] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [stateField, setStateField] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [trialPlan, setTrialPlan] = useState<'starter-m' | 'em-m'>('starter-m');
  const [submitting, setSubmitting] = useState(false);
  // Tracks the post-checkout phase. `null` = still on the form; otherwise
  // we render the spinner with a label that progresses through the bank +
  // provisioning steps so the customer knows something is happening.
  const [verifyPhase, setVerifyPhase] = useState<null | 'authorizing' | 'provisioning' | 'almost'>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  // Stash the Razorpay handler response so the "Retry" button on the
  // error state can re-call the verify endpoint with the same signature.
  // Lost on full page refresh — webhook is the safety net there.
  const [lastResp, setLastResp] = useState<{
    razorpay_payment_id: string;
    razorpay_subscription_id: string;
    razorpay_signature: string;
  } | null>(null);
  const activeSubscriptionId = lastResp?.razorpay_subscription_id ?? null;
  const [error, setError] = useState<string | null>(null);

  // ── Entry guard ──
  // If the caller already has an org (member OR owner) they should NOT see
  // this page. Happens on OAuth login when the existing-org check at
  // /post-login is bypassed (eg direct link, back button, refresh).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data: ownsOrg } = await supabase
        .from('organizations').select('id').eq('owner_user_id', user.id).maybeSingle();
      if (cancelled) return;
      if (ownsOrg) { navigate('/dashboard', { replace: true }); return; }
      const { data: member } = await supabase
        .from('org_members').select('org_id').eq('user_id', user.id).maybeSingle();
      if (cancelled) return;
      if (member) navigate('/dashboard', { replace: true });
    })();
    return () => { cancelled = true; };
  }, [user, navigate]);

  // After Razorpay's modal fires `handler()`, finalize INSTANTLY using the
  // signature Razorpay hands back. The server verifies the HMAC and runs
  // the same `finalize_pending_signup_v2` RPC the webhook would run — no
  // polling, no Razorpay round-trip. Total: typically < 1 second.
  //
  // The `subscription.authenticated` webhook still fires async as a safety
  // net. RPC is idempotent so duplicate finalize = no-op.
  const finalizeAfterPayment = async (resp: {
    razorpay_payment_id: string;
    razorpay_subscription_id: string;
    razorpay_signature: string;
  }) => {
    setVerifyPhase('provisioning');
    setVerifyError(null);
    setLastResp(resp);
    const { data: { session } } = await supabase.auth.getSession();

    // One call. On transient network failure we retry up to 3 times with
    // a short backoff — anything beyond that is a real failure that the
    // user should see + retry from the UI.
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-verify-payment`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session?.access_token ?? ''}`,
          },
          body: JSON.stringify({
            subscription_id:     resp.razorpay_subscription_id,
            razorpay_payment_id: resp.razorpay_payment_id,
            razorpay_signature:  resp.razorpay_signature,
          }),
        });
        const j = await r.json();
        if (r.ok && j.org_id) {
          await refreshOrganization();
          navigate('/dashboard', { replace: true });
          return;
        }
        if (j.fatal) {
          setVerifyError(j.error ?? 'Verification failed. Please contact support.');
          setVerifyPhase(null);
          return;
        }
        lastErr = j.error ?? `HTTP ${r.status}`;
      } catch (e) {
        lastErr = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    setVerifyError(
      `Could not confirm your trial: ${lastErr}. Your payment is safe — click Retry, or contact support with the reference below.`,
    );
    setVerifyPhase(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) { setError('Company name required'); return; }
    setSubmitting(true); setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in.');

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-start-signup`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          full_name:   user?.user_metadata?.full_name ?? user?.email ?? 'User',
          org_name:    companyName.trim(),
          plan_code:   trialPlan,
          phone:       phone.trim() || null,
          country:     country.trim() || 'India',
          gst_number:  gstNumber.trim() || null,
          pan_number:  panNumber.trim() || null,
          address:     address.trim() || null,
          city:        city.trim() || null,
          state:       stateField.trim() || null,
          postal_code: postalCode.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Signup failed');

      await startSubscriptionCheckout({
        keyId:          body.key_id,
        subscriptionId: body.subscription_id,
        customerName:   user?.user_metadata?.full_name ?? user?.email ?? '',
        customerEmail:  user?.email ?? '',
        customerPhone:  phone.trim() || null,
        amountLabel:    body.auth_amount_label,
        onSuccess: (resp) => {
          // Don't wait for the webhook — finalize directly using the
          // signature Razorpay just handed us. Sub-second on the happy path.
          void finalizeAfterPayment(resp);
        },
        onDismiss: () => {
          setError('Payment cancelled. Your trial will start once the card-verification charge succeeds.');
          setSubmitting(false);
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
      setSubmitting(false);
    }
  };

  if (verifyPhase) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 login-bg login-bg-emerald">
        <div className="relative z-10 w-full max-w-md bg-dark-900/80 backdrop-blur border border-dark-700 rounded-2xl p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 mx-auto mb-4 flex items-center justify-center">
            <i className="ri-loader-4-line text-2xl text-emerald-400 animate-spin" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">Activating your trial…</h1>
          <p className="text-sm text-gray-400">One moment.</p>
        </div>
      </div>
    );
  }

  if (verifyError && activeSubscriptionId) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 login-bg login-bg-emerald">
        <div className="relative z-10 w-full max-w-md bg-dark-900/80 backdrop-blur border border-dark-700 rounded-2xl p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-amber-500/15 border border-amber-500/40 mx-auto mb-4 flex items-center justify-center">
            <i className="ri-error-warning-line text-2xl text-amber-400" />
          </div>
          <h1 className="text-lg font-semibold text-white mb-2">Hang on — still finalising</h1>
          <p className="text-sm text-gray-300 mb-1">{verifyError}</p>
          <p className="text-[11px] text-gray-500 mb-5">Reference: <code className="text-gray-300">{activeSubscriptionId}</code></p>
          <button
            onClick={() => { if (lastResp) { setVerifyError(null); void finalizeAfterPayment(lastResp); } }}
            disabled={!lastResp}
            className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-dark-950 font-medium py-2.5 rounded-lg transition-colors mb-2"
          >
            Retry
          </button>
          <p className="text-[11px] text-gray-600">
            Still stuck? Email <a href="mailto:support@rudrans.com" className="text-emerald-400">support@rudrans.com</a> with the reference above — your payment is safe and refundable.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative overflow-hidden flex items-center justify-center px-4 py-8 login-bg login-bg-emerald">
      <div className="aurora aurora-a" aria-hidden />
      <div className="aurora aurora-b" aria-hidden />
      <div className="aurora aurora-c" aria-hidden />
      <div className="absolute inset-0 grid-overlay pointer-events-none" aria-hidden />

      <div className="relative z-10 w-full max-w-3xl">
        <div className="bg-dark-900/80 backdrop-blur border border-dark-700 rounded-2xl p-7">
          <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 mx-auto mb-4 flex items-center justify-center">
            <i className="ri-building-line text-2xl text-emerald-400" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-1 text-center">One last step</h1>
          <p className="text-xs text-gray-500 mb-6 text-center">
            Signed in as <span className="text-gray-300">{user?.email}</span>. A small refundable charge (₹2 / $0.50) verifies your card, then your 14-day trial begins.
          </p>

          {error && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Which trial do you want?</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([
                  { code: 'starter-m', title: 'Starter', desc: 'Monitoring, screenshots, video, productivity reports' },
                  { code: 'em-m',      title: 'Employee Management', desc: 'Attendance, leaves, payroll, KPIs' },
                ] as const).map((opt) => (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => setTrialPlan(opt.code)}
                    className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                      trialPlan === opt.code
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-dark-700 bg-dark-800 hover:border-dark-600'
                    }`}
                  >
                    <p className="text-sm text-white font-medium">{opt.title}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">{opt.desc}</p>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-600 mt-1.5">
                Need every module during the trial? Request full-features access from your Subscription page after signup — a super admin will review.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">Company Name *</label>
                <input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Your Company Pvt Ltd"
                  required
                  className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">Phone</label>
                <PhoneInput
                  value={phone}
                  onChange={setPhone}
                  defaultCountry={country || 'IN'}
                  className="flex-1 min-w-0 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">GST Number (optional)</label>
                <input
                  value={gstNumber}
                  onChange={(e) => setGstNumber(e.target.value)}
                  placeholder="22AAAAA0000A1Z5"
                  className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 uppercase"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">PAN Number</label>
                <input
                  value={panNumber}
                  onChange={(e) => setPanNumber(e.target.value)}
                  placeholder="AAAAA0000A"
                  className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 uppercase"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">Address</label>
              <textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street, area..."
                rows={2}
                maxLength={500}
                className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 resize-none"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="sm:col-span-3">
                <CountryStatePicker
                  country={country}
                  state={stateField}
                  city={city}
                  onChange={({ country: c, state: s, city: ci }) => { setCountry(c); setStateField(s); setCity(ci); }}
                  inputClassName="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="text-[11px] text-gray-500 uppercase tracking-wider block">Pincode</label>
                <input
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  placeholder="ZIP code"
                  inputMode="numeric"
                  maxLength={10}
                  className="mt-1 w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-dark-950 font-medium py-2.5 rounded-lg transition-colors"
            >
              {submitting ? 'Opening payment…' : 'Verify Card & Start 14-Day Trial'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
