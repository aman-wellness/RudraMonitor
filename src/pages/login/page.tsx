import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';
import LoginLayout, { loginInputClass } from '@/components/feature/LoginLayout';

export default function Login() {
  const navigate = useNavigate();
  const { signIn, signInWithGoogle, signInWithMicrosoft, signOut } = useAuth();
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
      const { data: u } = await supabase.auth.getUser();
      const userId = u.user?.id;
      const { data: app } = await supabase
        .from('app_users')
        .select('app_role')
        .eq('user_id', userId)
        .maybeSingle();
      const { count: orgMemberCount } = await supabase
        .from('org_members')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);
      const hasOrg = (orgMemberCount ?? 0) > 0;
      if (!hasOrg && app?.app_role === 'partner') {
        await signOut();
        setError('Partners must sign in from the Partner Login page.');
        return;
      }
      if (!hasOrg && app?.app_role === 'super_admin') {
        await signOut();
        setError('Super admins must sign in from /super.');
        return;
      }
      navigate('/dashboard', { replace: true });
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
      brandLabel="TrackForce"
      brandIcon="ri-shield-check-line"
      illustrationUrl="https://illustrations.popsy.co/violet/work-from-home.svg"
      illustrationCaption="Welcome back"
      illustrationSubtitle="Sign in to manage your team's productivity, track agents, and review insights — all from one place."
      title="Sign In"
      subtitle="Enter your credentials to access your TrackForce admin portal."
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
          <a href="#" className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">Forgot Password</a>
        </div>
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
