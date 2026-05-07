import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function Login() {
  const navigate = useNavigate();
  const { signIn, signInWithGoogle, signInWithMicrosoft } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
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

  return (
    <div className="min-h-screen bg-dark-900 flex items-center justify-center px-4">
      {/* Background effects */}
      <div className="fixed top-0 right-0 w-[500px] h-[500px] bg-emerald-500/5 rounded-full blur-[120px]" />
      <div className="fixed bottom-0 left-0 w-[400px] h-[400px] bg-teal-500/5 rounded-full blur-[100px]" />

      <div className="relative z-10 w-full max-w-md">
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
          <h1 className="text-xl md:text-2xl font-poppins font-bold text-white text-center mb-2">
            Welcome Back
          </h1>
          <p className="text-sm text-gray-500 text-center mb-6">
            Sign in to your admin portal
          </p>

          {/* Social Login */}
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

          {error && (
            <div className="mb-4 px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-xs">
              {error}
            </div>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-dark-700" />
            <span className="text-xs text-gray-500">or sign in with email</span>
            <div className="flex-1 h-px bg-dark-700" />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
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
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
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
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
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

            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 rounded border-dark-700 bg-dark-900 text-emerald-500 focus:ring-emerald-500" />
                <span className="text-xs text-gray-500">Remember me</span>
              </label>
              <a href="#" className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors">
                Forgot password?
              </a>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed text-white py-2.5 rounded-lg font-medium transition-all duration-200"
            >
              {submitting ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          {/* Sign up link */}
          <p className="text-sm text-gray-500 text-center mt-6">
            Don&apos;t have an account?{' '}
            <Link to="/signup" className="text-emerald-400 hover:text-emerald-300 transition-colors font-medium">
              Start Free Trial
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