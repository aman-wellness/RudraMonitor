import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { startSubscriptionCheckout } from '../../lib/razorpay';
import { useAuth } from '../../context/AuthContext';
import PhoneInput from '@/components/forms/PhoneInput';
import CountryStatePicker from '@/components/forms/CountryStatePicker';

export default function Signup() {
  const navigate = useNavigate();
  const { signUp, signInWithGoogle, signInWithMicrosoft, refreshOrganization } = useAuth();
  const [step, setStep] = useState(1);
  // Which trial bundle the customer wants. starter-m = basic monitoring
  // (default), em-m = employee-management-only. Full-features trial
  // requires a super-admin approval after signup (Subscription page).
  const [trialPlan, setTrialPlan] = useState<'starter-m' | 'em-m'>('starter-m');
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    companyName: '',
    gstNumber: '',
    panNumber: '',
    address: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'IN', // ISO2 — drives PhoneInput default + CountryStatePicker
    phone: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Email OTP state (free — delivered via Microsoft Graph). The OTP is on the
  // email field from step 1; phone is just collected as profile data.
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [otpResendIn, setOtpResendIn] = useState(0);
  const [otpMsg, setOtpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const sendOtp = async () => {
    setOtpMsg(null);
    if (!formData.email.includes('@')) {
      setOtpMsg({ kind: 'err', text: 'Enter a valid email address.' });
      return;
    }
    setOtpSending(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-phone-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({ email: formData.email }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `OTP send failed (${res.status})`);
      setOtpSent(true);
      setOtpMsg({ kind: 'ok', text: `OTP sent to ${formData.email}. It expires in 5 minutes.` });
      setOtpResendIn(45);
      const i = setInterval(() => {
        setOtpResendIn((s) => { if (s <= 1) { clearInterval(i); return 0; } return s - 1; });
      }, 1000);
    } catch (e) {
      setOtpMsg({ kind: 'err', text: e instanceof Error ? e.message : 'OTP send failed' });
    } finally { setOtpSending(false); }
  };

  const verifyOtp = async () => {
    setOtpMsg(null);
    if (!/^\d{6}$/.test(otp)) {
      setOtpMsg({ kind: 'err', text: 'Enter the 6-digit code from the email.' });
      return;
    }
    setOtpVerifying(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/verify-phone-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({ email: formData.email, otp }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'Invalid OTP');
      setEmailVerified(true);
      setOtpMsg({ kind: 'ok', text: 'Email verified ✓' });
    } catch (e) {
      setOtpMsg({ kind: 'err', text: e instanceof Error ? e.message : 'OTP verification failed' });
    } finally { setOtpVerifying(false); }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleOAuth = async (provider: 'google' | 'microsoft') => {
    setError(null);
    try {
      if (provider === 'google') await signInWithGoogle();
      else await signInWithMicrosoft();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OAuth failed');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (step === 1) {
      if (!formData.email.includes('@')) {
        setError('Enter a valid email');
        return;
      }
      if (!formData.fullName.trim()) {
        setError('Enter your full name');
        return;
      }
      setStep(2);
      return;
    }

    if (!emailVerified) {
      setError('Please verify your email with the OTP first.');
      return;
    }

    setSubmitting(true);
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/razorpay-start-signup`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({
          full_name:   formData.fullName,
          email:       formData.email,
          org_name:    formData.companyName,
          plan_code:   trialPlan,
          phone:       formData.phone || null,
          country:     formData.country,
          gst_number:  formData.gstNumber || null,
          pan_number:  formData.panNumber || null,
          address:     formData.address || null,
          city:        formData.city || null,
          state:       formData.state || null,
          postal_code: formData.postalCode || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Signup failed');

      // Open Razorpay Checkout for the ₹2 / $0.50 card-verification charge.
      // The trial only starts after the webhook fires (subscription.authenticated)
      // — it creates the auth user, sends the invite email, and provisions the org.
      await startSubscriptionCheckout({
        keyId:         body.key_id,
        subscriptionId: body.subscription_id,
        customerName:  formData.fullName,
        customerEmail: formData.email,
        customerPhone: formData.phone || null,
        amountLabel:   body.auth_amount_label,
        onSuccess: () => {
          navigate(`/signup-success?email=${encodeURIComponent(formData.email)}`);
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


  return (
    <div className="min-h-screen relative overflow-hidden flex items-center justify-center px-4 py-8 login-bg login-bg-emerald">
      <div className="aurora aurora-a" aria-hidden />
      <div className="aurora aurora-b" aria-hidden />
      <div className="aurora aurora-c" aria-hidden />
      <div className="absolute inset-0 grid-overlay pointer-events-none" aria-hidden />

      <div className={`relative z-10 w-full ${step === 2 ? 'max-w-3xl' : 'max-w-lg'}`}>
        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-3">
            <img
              src="https://public.readdy.ai/ai/img_res/30434500-ce14-4d0b-944f-490cb4702e27.png"
              alt="Rudrans Logo"
              className="h-10 w-10 object-contain"
            />
            <span className="text-white font-poppins font-bold text-xl">
              Rudrans
            </span>
          </Link>
        </div>

        {/* Card */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-6 md:p-8 shadow-2xl">
          {/* Step indicator */}
          <div className="flex items-center gap-2 mb-6">
            <div className={`flex-1 h-1 rounded-full ${step >= 1 ? 'bg-emerald-500' : 'bg-dark-700'}`} />
            <div className={`flex-1 h-1 rounded-full ${step >= 2 ? 'bg-emerald-500' : 'bg-dark-700'}`} />
          </div>

          <h1 className="text-xl md:text-2xl font-poppins font-bold text-white text-center mb-2">
            {step === 1 ? 'Create Your Account' : 'Organization Details'}
          </h1>
          <p className="text-sm text-gray-500 text-center mb-6">
            {step === 1
              ? 'Start your 14-day free trial today'
              : 'Fill your company information'}
          </p>

          {/* Social Login */}
          {step === 1 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                <button
                  type="button"
                  onClick={() => handleOAuth('google')}
                  className="flex items-center justify-center gap-2 bg-dark-900 border border-dark-700 hover:border-dark-600 text-white py-2.5 rounded-lg transition-all text-sm"
                >
                  <span className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-google-fill text-lg" />
                  </span>
                  Google
                </button>
                <button
                  type="button"
                  onClick={() => handleOAuth('microsoft')}
                  className="flex items-center justify-center gap-2 bg-dark-900 border border-dark-700 hover:border-dark-600 text-white py-2.5 rounded-lg transition-all text-sm"
                >
                  <span className="w-5 h-5 flex items-center justify-center">
                    <i className="ri-microsoft-fill text-lg" />
                  </span>
                  Microsoft
                </button>
              </div>

              <div className="flex items-center gap-3 mb-6">
                <div className="flex-1 h-px bg-dark-700" />
                <span className="text-xs text-gray-500">or sign up with email</span>
                <div className="flex-1 h-px bg-dark-700" />
              </div>
            </>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {step === 1 ? (
              <>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">
                    Full Name
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500">
                      <i className="ri-user-line" />
                    </span>
                    <input
                      type="text"
                      name="fullName"
                      value={formData.fullName}
                      onChange={handleChange}
                      placeholder="John Doe"
                      required
                      className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">
                    Email Address {emailVerified && <span className="text-emerald-400 text-xs ml-1">✓ verified</span>}
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1 min-w-0">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500">
                        <i className="ri-mail-line" />
                      </span>
                      <input
                        type="email"
                        name="email"
                        value={formData.email}
                        onChange={(e) => { handleChange(e); setEmailVerified(false); setOtpSent(false); }}
                        disabled={emailVerified}
                        placeholder="admin@company.com"
                        required
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 disabled:opacity-60 transition-colors"
                      />
                    </div>
                    {!emailVerified && (
                      <button
                        type="button"
                        onClick={sendOtp}
                        disabled={otpSending || !formData.email.includes('@') || otpResendIn > 0}
                        className="shrink-0 px-3 py-2 text-xs rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {otpSending ? 'Sending…' : otpResendIn > 0 ? `Resend ${otpResendIn}s` : otpSent ? 'Resend' : 'Send OTP'}
                      </button>
                    )}
                  </div>
                  {otpSent && !emailVerified && (
                    <div className="mt-2 flex gap-2">
                      <input
                        inputMode="numeric"
                        maxLength={6}
                        value={otp}
                        onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="Enter 6-digit code"
                        className="flex-1 min-w-0 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 tracking-widest"
                      />
                      <button
                        type="button"
                        onClick={verifyOtp}
                        disabled={otpVerifying || otp.length !== 6}
                        className="shrink-0 px-4 py-2 text-xs rounded-lg bg-emerald-500 text-dark-950 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                      >
                        {otpVerifying ? 'Verifying…' : 'Verify'}
                      </button>
                    </div>
                  )}
                  {otpMsg && (
                    <p className={`mt-2 text-xs px-2.5 py-1.5 rounded-md border ${otpMsg.kind === 'ok' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-rose-500/10 border-rose-500/30 text-rose-300'}`}>
                      {otpMsg.text}
                    </p>
                  )}
                </div>

                <div className="flex items-start gap-2">
                  <input type="checkbox" required className="mt-0.5 w-4 h-4 rounded border-dark-700 bg-dark-900 text-emerald-500 focus:ring-emerald-500" />
                  <span className="text-xs text-gray-500">
                    I agree to the{' '}
                    <a href="#" className="text-emerald-400 hover:text-emerald-300">Terms of Service</a>
                    {' '}and{' '}
                    <a href="#" className="text-emerald-400 hover:text-emerald-300">Privacy Policy</a>
                  </span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">
                    Which trial do you want?
                  </label>
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
                            : 'border-dark-700 bg-dark-900 hover:border-dark-600'
                        }`}
                      >
                        <p className="text-sm text-white font-medium">{opt.title}</p>
                        <p className="text-[11px] text-gray-500 mt-0.5">{opt.desc}</p>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-gray-600 mt-1.5">
                    Need every module during the trial? You can request full-features access from your Subscription page after signing up — a super admin will review.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">
                      Company Name
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500">
                        <i className="ri-building-line" />
                      </span>
                      <input
                        type="text"
                        name="companyName"
                        value={formData.companyName}
                        onChange={handleChange}
                        placeholder="Your Company Pvt Ltd"
                        required
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Phone Number</label>
                    <PhoneInput
                      value={formData.phone}
                      onChange={(next) => setFormData({ ...formData, phone: next })}
                      defaultCountry={formData.country || 'IN'}
                      className="flex-1 min-w-0 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">
                      GST Number (Optional)
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500">
                        <i className="ri-barcode-line" />
                      </span>
                      <input
                        type="text"
                        name="gstNumber"
                        value={formData.gstNumber}
                        onChange={handleChange}
                        placeholder="22AAAAA0000A1Z5"
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">
                      PAN Number
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500">
                        <i className="ri-id-card-line" />
                      </span>
                      <input
                        type="text"
                        name="panNumber"
                        value={formData.panNumber}
                        onChange={handleChange}
                        placeholder="AAAAA0000A"
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors uppercase"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">
                    Address
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-3 w-5 h-5 flex items-center justify-center text-gray-500">
                      <i className="ri-map-pin-line" />
                    </span>
                    <textarea
                      name="address"
                      value={formData.address}
                      onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                      placeholder="Full address..."
                      rows={2}
                      maxLength={500}
                      className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors resize-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div className="sm:col-span-3">
                    <CountryStatePicker
                      country={formData.country}
                      state={formData.state}
                      city={formData.city}
                      onChange={({ country, state, city }) => setFormData({ ...formData, country, state, city })}
                      inputClassName="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-500 uppercase tracking-wider block">Pincode</label>
                    <input
                      type="text"
                      name="postalCode"
                      value={formData.postalCode}
                      onChange={handleChange}
                      placeholder="ZIP code"
                      inputMode="numeric"
                      maxLength={10}
                      className="mt-1 w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>
              </>
            )}

            {error && (
              <div className="px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-xs">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || (step === 1 && !emailVerified)}
              className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed text-white py-2.5 rounded-lg font-medium transition-all duration-200"
              title={step === 1 && !emailVerified ? 'Verify your email with the OTP first' : undefined}
            >
              {submitting ? 'Opening payment…' : step === 1 ? 'Continue' : 'Verify Card & Start 14-Day Trial'}
            </button>
          </form>

          {/* Login link */}
          <p className="text-sm text-gray-500 text-center mt-6">
            Already have an account?{' '}
            <Link to="/login" className="text-emerald-400 hover:text-emerald-300 transition-colors font-medium">
              Sign In
            </Link>
          </p>
        </div>

        {/* Footer */}
        <p className="text-xs text-gray-600 text-center mt-6">
          &copy; 2025 Rudrans. All rights reserved.
        </p>
      </div>
    </div>
  );
}