import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

/**
 * Shown right after an OAuth signup (Google / Microsoft) for users who don't
 * have an org yet. OTP is skipped — the OAuth provider already verified the
 * email. The form collects org name, phone, country and calls the same
 * `create_self_signup_trial` RPC the password-flow uses.
 */
export default function CompleteSignup() {
  const navigate = useNavigate();
  const { user, refreshOrganization } = useAuth();

  const [companyName, setCompanyName] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('India');
  const [trialPlan, setTrialPlan] = useState<'starter-m' | 'em-m'>('starter-m');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) { setError('Company name required'); return; }
    setSubmitting(true); setError(null);
    const { error: rpcErr } = await supabase.rpc('create_self_signup_trial', {
      p_org_name:   companyName.trim(),
      p_phone:      phone.trim() || null,
      p_country:    country.trim() || 'India',
      p_trial_plan: trialPlan,
    });
    setSubmitting(false);
    if (rpcErr) { setError(rpcErr.message); return; }
    await refreshOrganization();
    navigate('/dashboard', { replace: true });
  };

  return (
    <div className="min-h-screen relative overflow-hidden flex items-center justify-center px-4 py-8 login-bg login-bg-emerald">
      <div className="aurora aurora-a" aria-hidden />
      <div className="aurora aurora-b" aria-hidden />
      <div className="aurora aurora-c" aria-hidden />
      <div className="absolute inset-0 grid-overlay pointer-events-none" aria-hidden />

      <div className="relative z-10 w-full max-w-md">
        <div className="bg-dark-900/80 backdrop-blur border border-dark-700 rounded-2xl p-7">
          <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 mx-auto mb-4 flex items-center justify-center">
            <i className="ri-building-line text-2xl text-emerald-400" />
          </div>
          <h1 className="text-xl font-semibold text-white mb-1 text-center">One last step</h1>
          <p className="text-xs text-gray-500 mb-6 text-center">
            Signed in as <span className="text-gray-300">{user?.email}</span>. Tell us about your organization to start your free 14-day trial.
          </p>

          {error && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Which trial do you want?</label>
              <div className="grid grid-cols-1 gap-2">
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
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">Phone</label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">Country</label>
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                >
                  <option value="India">India</option>
                  <option value="USA">USA</option>
                  <option value="UK">UK</option>
                  <option value="UAE">UAE</option>
                  <option value="Singapore">Singapore</option>
                  <option value="Australia">Australia</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-dark-950 font-medium py-2.5 rounded-lg transition-colors"
            >
              {submitting ? 'Creating trial…' : 'Start 14-Day Trial'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
