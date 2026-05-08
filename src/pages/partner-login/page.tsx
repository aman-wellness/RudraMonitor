import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import LoginLayout, { loginInputClass } from '@/components/feature/LoginLayout';

export default function PartnerLogin() {
  const navigate = useNavigate();
  const { signIn, signOut } = useAuth();
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
      const { data: app } = await supabase
        .from('app_users')
        .select('app_role')
        .eq('user_id', u.user?.id)
        .maybeSingle();
      if (!app || app.app_role !== 'partner') {
        await signOut();
        setError('This portal is for partners only. Use the customer or super-admin login instead.');
        return;
      }
      navigate('/partner/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <LoginLayout
      accent="violet"
      brandLabel="TrackForce Partners"
      brandIcon="ri-team-line"
      illustrationUrl="https://illustrations.popsy.co/violet/business-deal.svg"
      illustrationCaption="Grow your channel"
      illustrationSubtitle="Sign in to your partner portal to manage customers, track licenses, and view commission earnings."
      title="Partner Portal"
      subtitle="Sign in to manage your customers, licenses and commissions."
      footer={
        <p className="text-sm text-slate-500 text-center">
          Want to become a partner?{' '}
          <Link to="/partner-signup" className="text-violet-600 hover:text-violet-700 font-medium">Apply here</Link>
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
            placeholder="partner@company.com"
            className={`${loginInputClass} focus:border-violet-500 focus:ring-violet-500`} />
        </div>
        <div>
          <label className="block text-xs text-slate-500 uppercase tracking-wider mb-1.5">Password</label>
          <div className="relative">
            <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required
              placeholder="••••••••"
              className={`${loginInputClass} pr-11 focus:border-violet-500 focus:ring-violet-500`} />
            <button type="button" onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-slate-600">
              <i className={showPassword ? 'ri-eye-off-line' : 'ri-eye-line'} />
            </button>
          </div>
        </div>
        <button type="submit" disabled={submitting}
          className="w-full bg-violet-500 hover:bg-violet-600 disabled:opacity-60 text-white py-3 rounded-lg font-medium transition-all shadow-lg shadow-violet-500/30 mt-2">
          {submitting ? 'Signing in…' : 'Log In'}
        </button>
      </form>
    </LoginLayout>
  );
}
