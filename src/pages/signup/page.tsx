import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../context/AuthContext';

export default function Signup() {
  const navigate = useNavigate();
  const { signUp, signInWithGoogle, signInWithMicrosoft, refreshOrganization } = useAuth();
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
    companyName: '',
    gstNumber: '',
    address: '',
    city: '',
    state: '',
    country: 'India',
    phone: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      if (formData.password !== formData.confirmPassword) {
        setError('Passwords do not match');
        return;
      }
      if (formData.password.length < 8) {
        setError('Password must be at least 8 characters');
        return;
      }
      setStep(2);
      return;
    }

    setSubmitting(true);
    try {
      // 1. Create the auth user
      const { userId } = await signUp({
        email: formData.email,
        password: formData.password,
        fullName: formData.fullName,
      });

      // 2. Create the organization (RLS requires owner_user_id = auth.uid())
      const { data: org, error: orgErr } = await supabase
        .from('organizations')
        .insert({
          owner_user_id: userId,
          name: formData.companyName,
          gst_number: formData.gstNumber || null,
          address: formData.address || null,
          city: formData.city || null,
          state: formData.state || null,
          country: formData.country,
          phone: formData.phone,
        })
        .select()
        .single();
      if (orgErr) throw orgErr;

      // 3. Add the user as an owner member
      const { error: memErr } = await supabase.from('org_members').insert({
        org_id: org.id,
        user_id: userId,
        role: 'owner',
        full_name: formData.fullName,
      });
      if (memErr) throw memErr;

      await refreshOrganization();
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden flex items-center justify-center px-4 py-8 login-bg login-bg-emerald">
      <div className="aurora aurora-a" aria-hidden />
      <div className="aurora aurora-b" aria-hidden />
      <div className="aurora aurora-c" aria-hidden />
      <div className="absolute inset-0 grid-overlay pointer-events-none" aria-hidden />

      <div className="relative z-10 w-full max-w-lg">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-3">
            <img
              src="https://public.readdy.ai/ai/img_res/30434500-ce14-4d0b-944f-490cb4702e27.png"
              alt="TrackForce Logo"
              className="h-10 w-10 object-contain"
            />
            <span className="text-white font-poppins font-bold text-xl">
              TrackForce
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
              <div className="grid grid-cols-2 gap-3 mb-6">
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
                    Email Address
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500">
                      <i className="ri-mail-line" />
                    </span>
                    <input
                      type="email"
                      name="email"
                      value={formData.email}
                      onChange={handleChange}
                      placeholder="admin@company.com"
                      required
                      className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500">
                      <i className="ri-lock-line" />
                    </span>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      name="password"
                      value={formData.password}
                      onChange={handleChange}
                      placeholder="Min 8 characters"
                      required
                      minLength={8}
                      className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-10 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500 hover:text-gray-400"
                    >
                      <i className={showPassword ? 'ri-eye-off-line' : 'ri-eye-line'} />
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500">
                      <i className="ri-lock-line" />
                    </span>
                    <input
                      type="password"
                      name="confirmPassword"
                      value={formData.confirmPassword}
                      onChange={handleChange}
                      placeholder="Repeat password"
                      required
                      className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                  </div>
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
                  <p className="text-xs text-gray-600 mt-1">
                    Enter GST number to auto-fetch company details
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">
                      Phone Number
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-500">
                        <i className="ri-phone-line" />
                      </span>
                      <input
                        type="tel"
                        name="phone"
                        value={formData.phone}
                        onChange={handleChange}
                        placeholder="+91 98765 43210"
                        required
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">
                      Country
                    </label>
                    <select
                      name="country"
                      value={formData.country}
                      onChange={handleChange}
                      className="w-full bg-dark-900 border border-dark-700 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
                    >
                      <option value="India">India</option>
                      <option value="USA">USA</option>
                      <option value="UK">UK</option>
                      <option value="Canada">Canada</option>
                      <option value="Australia">Australia</option>
                    </select>
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

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">
                      City
                    </label>
                    <input
                      type="text"
                      name="city"
                      value={formData.city}
                      onChange={handleChange}
                      placeholder="City"
                      className="w-full bg-dark-900 border border-dark-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">
                      State
                    </label>
                    <input
                      type="text"
                      name="state"
                      value={formData.state}
                      onChange={handleChange}
                      placeholder="State"
                      className="w-full bg-dark-900 border border-dark-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
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
              disabled={submitting}
              className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed text-white py-2.5 rounded-lg font-medium transition-all duration-200"
            >
              {submitting ? 'Creating account…' : step === 1 ? 'Continue' : 'Start 14-Day Free Trial'}
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
          &copy; 2025 TrackForce. All rights reserved.
        </p>
      </div>
    </div>
  );
}