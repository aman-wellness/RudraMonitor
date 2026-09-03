import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import LoginLayout, { loginInputClass } from '@/components/feature/LoginLayout';

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { signIn, signInWithGoogle, signInWithMicrosoft } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotMsg, setForgotMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Surface friendly errors from auth-bounce-back URLs (e.g. post-login sends
  // a Google-OAuth user back here when they tried to log in but had no
  // account — instead of silently signing them up).
  useEffect(() => {
    const code = params.get('error');
    if (code === 'no_account') {
      setError("No account found for that email. Click 'Start Free Trial' below to sign up first.");
    }
  }, [params]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      // Defer role / org routing to /post-login — it already handles partner
      // / super-admin / customer / complete-signup branching. Doing those
      // queries inline here meant 4 sequential round-trips on the critical
      // login path, which combined with React state propagation lag caused
      // ProtectedRoute to occasionally bounce users back to the landing page.
      navigate('/post-login', { replace: true });
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
    <LoginLayout
      accent="indigo"
      brandLabel="Wellness Extract"
      brandIcon="ri-shield-check-line"
      illustrationUrl="/rudrans/rudrans-laptop.webp"
      illustrationCaption="Welcome back"
      illustrationSubtitle="Sign in to manage your team's productivity, track agents, and review insights — all from one place."
      title="Sign In"
      subtitle="Enter your credentials to access your Wellness Extract admin portal."
      footer={
        <p className="text-sm text-slate-500 text-center">
          Don&apos;t have an account?{' '}
          <Link to="/signup" className="text-indigo-600 hover:text-indigo-700 font-medium">Start Free Trial</Link>
        </p>
      }
    >
      {error && (
        <div className="mb-5 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-red-600 text-xs">{error}</div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs text-slate-500 uppercase tracking-wider mb-1.5">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
            placeholder="you@company.com"
            className={`${loginInputClass} focus:border-indigo-500 focus:ring-indigo-500`} />
        </div>
        <div>
          <label className="block text-xs text-slate-500 uppercase tracking-wider mb-1.5">Password</label>
          <div className="relative">
            <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required
              placeholder="••••••••"
              className={`${loginInputClass} pr-11 focus:border-indigo-500 focus:ring-indigo-500`} />
            <button type="button" onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-slate-600">
              <i className={showPassword ? 'ri-eye-off-line' : 'ri-eye-line'} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox"
              className="w-4 h-4 rounded border-slate-300 bg-white text-indigo-500 focus:ring-indigo-500 cursor-pointer" />
            <span className="text-xs text-slate-600">Remember me</span>
          </label>
          <button
            type="button"
            disabled={forgotBusy}
            onClick={async () => {
              setForgotMsg(null);
              const target = email.trim();
              if (!target) { setForgotMsg({ kind: 'err', text: 'Enter your email above first.' }); return; }
              setForgotBusy(true);
              const { error: re } = await supabase.auth.resetPasswordForEmail(target, {
                redirectTo: `${window.location.origin}/reset-password`,
              });
              setForgotBusy(false);
              if (re) setForgotMsg({ kind: 'err', text: re.message });
              else setForgotMsg({ kind: 'ok', text: `Reset link sent to ${target}.` });
            }}
            className="text-xs text-indigo-600 hover:text-indigo-700 font-medium disabled:opacity-50"
          >
            {forgotBusy ? 'Sending…' : 'Forgot Password'}
          </button>
        </div>
        {forgotMsg && (
          <p className={`text-xs px-3 py-2 rounded-lg border ${forgotMsg.kind === 'ok' ? 'text-indigo-700 bg-indigo-50 border-indigo-200' : 'text-red-600 bg-red-50 border-red-200'}`}>
            {forgotMsg.text}
          </p>
        )}
        <button type="submit" disabled={submitting}
          className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:opacity-60 text-white py-3 rounded-lg font-medium transition-all shadow-lg shadow-indigo-500/30 mt-2">
          {submitting ? 'Signing in…' : 'Log In'}
        </button>
      </form>

      <div className="flex items-center justify-center my-8 text-xs text-slate-400">
        <span className="text-slate-300">— or login with —</span>
      </div>
      <div className="flex items-center justify-center gap-3">
        <button type="button" onClick={() => handleOAuth('google')} aria-label="Sign in with Google"
          className="w-12 h-12 rounded-full bg-rose-500 hover:bg-rose-600 text-white flex items-center justify-center transition-all hover:scale-105 shadow-md shadow-rose-500/30">
          <i className="ri-google-fill text-lg" />
        </button>
        <button type="button" onClick={() => handleOAuth('microsoft')} aria-label="Sign in with Microsoft"
          className="w-12 h-12 rounded-full bg-sky-500 hover:bg-sky-600 text-white flex items-center justify-center transition-all hover:scale-105 shadow-md shadow-sky-500/30">
          <i className="ri-microsoft-fill text-lg" />
        </button>
        <Link to="/partner/login" aria-label="Partner login"
          className="w-12 h-12 rounded-full bg-violet-500 hover:bg-violet-600 text-white flex items-center justify-center transition-all hover:scale-105 shadow-md shadow-violet-500/30">
          <i className="ri-team-line text-lg" />
        </Link>
      </div>
    </LoginLayout>
  );
}
