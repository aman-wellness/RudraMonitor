import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import LoginLayout, { loginInputClass } from '@/components/feature/LoginLayout';
import ForgotPasswordLink from '@/components/feature/ForgotPasswordLink';

/**
 * Internal-only super-admin login. Reachable only by typing the URL directly.
 * Strict role gate: anyone who is not super_admin is signed out immediately
 * with a generic error so the URL can't be used as an account-existence oracle.
 */
export default function SuperLogin() {
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
      if (!u.user?.id) {
        setError('Sign-in succeeded but no user session — try again.');
        return;
      }
      const { data: app, error: appErr } = await supabase
        .from('app_users')
        .select('app_role')
        .eq('user_id', u.user.id)
        .maybeSingle();
      if (appErr) {
        await signOut();
        setError(`Role lookup failed: ${appErr.message}`);
        return;
      }
      if (!app) {
        await signOut();
        setError("Access denied — this account isn't registered as a super-admin. Ask an existing super-admin to invite you from /admin/users.");
        return;
      }
      if (app.app_role !== 'super_admin') {
        await signOut();
        setError(`Access denied — your role is "${app.app_role}", not "super_admin".`);
        return;
      }
      navigate('/admin/dashboard', { replace: true });
    } catch (e) {
      const msg = (e as Error).message ?? 'Sign-in failed';
      setError(/invalid login|invalid email|password/i.test(msg)
        ? 'Wrong email or password.'
        : `Sign-in error: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <LoginLayout
      accent="purple"
      brandLabel="Super Admin"
      brandIcon="ri-shield-keyhole-line"
      illustrationUrl="https://illustrations.popsy.co/violet/security.svg"
      illustrationCaption="Internal access only"
      illustrationSubtitle="This portal is restricted to Rudrans engineers and support staff. All actions are logged to the audit trail."
      title="Super Admin"
      subtitle="Internal access — sign in with your Rudrans admin credentials."
    >
      {error && (
        <div className="mb-5 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-red-600 text-xs">{error}</div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs text-slate-500 uppercase tracking-wider mb-1.5">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email"
            placeholder="admin@rudrans.com"
            className={`${loginInputClass} focus:border-purple-500 focus:ring-purple-500`} />
        </div>
        <div>
          <label className="block text-xs text-slate-500 uppercase tracking-wider mb-1.5">Password</label>
          <div className="relative">
            <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password"
              placeholder="••••••••"
              className={`${loginInputClass} pr-11 focus:border-purple-500 focus:ring-purple-500`} />
            <button type="button" onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-slate-600">
              <i className={showPassword ? 'ri-eye-off-line' : 'ri-eye-line'} />
            </button>
          </div>
        </div>
        <ForgotPasswordLink email={email} accent="purple" />
        <button type="submit" disabled={submitting}
          className="w-full bg-purple-500 hover:bg-purple-600 disabled:opacity-60 text-white py-3 rounded-lg font-medium transition-all shadow-lg shadow-purple-500/30 mt-2">
          {submitting ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </LoginLayout>
  );
}
