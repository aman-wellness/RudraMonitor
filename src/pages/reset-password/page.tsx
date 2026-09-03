import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import LoginLayout, { loginInputClass } from '@/components/feature/LoginLayout';

/**
 * Recovery landing page. Supabase email links bring the user here with a token
 * in the URL hash (#access_token=…&type=recovery). The supabase-js client picks
 * that up automatically via detectSessionInUrl, so by the time this component
 * renders the user is already signed in via a *recovery* session — they can
 * call auth.updateUser({ password }) without a current-password challenge.
 *
 * After they pick a new password, we route based on their role so partners
 * land in the partner portal, customers in the dashboard, super-admins in the
 * admin portal — instead of bouncing everyone to /login.
 */
export default function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [accent, setAccent] = useState<'indigo' | 'violet' | 'purple'>('indigo');
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // Wait for supabase-js to consume the hash (detectSessionInUrl) and surface
    // the recovery session. We then peek at app_users to colour the page in the
    // brand accent that matches the audience.
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session?.user) {
        // No recovery session — link expired or already consumed elsewhere.
        setError('This recovery link is invalid or has expired. Request a new one from your admin.');
        setReady(true);
        return;
      }
      const { data: app } = await supabase
        .from('app_users')
        .select('app_role')
        .eq('user_id', data.session.user.id)
        .maybeSingle();
      if (app?.app_role === 'partner') setAccent('violet');
      else if (app?.app_role === 'super_admin') setAccent('purple');
      setReady(true);
    })();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pwd.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (pwd !== pwd2) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    const { error: upErr } = await supabase.auth.updateUser({ password: pwd });
    setSubmitting(false);
    if (upErr) { setError(upErr.message); return; }
    setSuccess(true);

    // Route the just-reset user to whichever portal they belong to.
    const { data: u } = await supabase.auth.getUser();
    const userId = u.user?.id;
    if (!userId) { navigate('/login', { replace: true }); return; }
    const { data: app } = await supabase
      .from('app_users')
      .select('app_role')
      .eq('user_id', userId)
      .maybeSingle();
    setTimeout(() => {
      if (app?.app_role === 'super_admin') navigate('/admin/dashboard', { replace: true });
      else if (app?.app_role === 'partner') navigate('/partner/dashboard', { replace: true });
      else navigate('/dashboard', { replace: true });
    }, 1200);
  };

  const titleByAccent = accent === 'violet' ? 'Reset Partner Portal Password'
    : accent === 'purple' ? 'Reset Super-Admin Password'
    : 'Reset Your Password';
  const ringClass = accent === 'violet' ? 'focus:border-violet-500 focus:ring-violet-500'
    : accent === 'purple' ? 'focus:border-purple-500 focus:ring-purple-500'
    : 'focus:border-indigo-500 focus:ring-indigo-500';
  const btnClass = accent === 'violet' ? 'bg-violet-500 hover:bg-violet-600 shadow-violet-500/30'
    : accent === 'purple' ? 'bg-purple-500 hover:bg-purple-600 shadow-purple-500/30'
    : 'bg-indigo-500 hover:bg-indigo-600 shadow-indigo-500/30';

  return (
    <LoginLayout
      accent={accent}
      brandLabel={accent === 'violet' ? 'Wellness Extract Partners' : accent === 'purple' ? 'Super Admin' : 'Wellness Extract'}
      brandIcon={accent === 'violet' ? 'ri-team-line' : accent === 'purple' ? 'ri-shield-keyhole-line' : 'ri-shield-check-line'}
      illustrationUrl={accent === 'violet'
        ? '/rudrans/hero-mascot-v2.webp'
        : '/rudrans/rudrans-laptop.webp'}
      illustrationCaption="Set a new password"
      illustrationSubtitle="Pick a strong password — at least 8 characters. We'll log you in to your portal as soon as you save."
      title={titleByAccent}
      subtitle={ready ? 'Choose a new password to continue.' : 'Verifying recovery link…'}
    >
      {!ready ? (
        <div className="text-xs text-slate-400">Verifying…</div>
      ) : success ? (
        <div className="px-3 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 text-sm">
          ✓ Password updated. Redirecting to your portal…
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-5 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-red-600 text-xs">{error}</div>
          )}
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs text-slate-500 uppercase tracking-wider mb-1.5">New Password</label>
              <div className="relative">
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  className={`${loginInputClass} pr-11 ${ringClass}`}
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-slate-600">
                  <i className={showPwd ? 'ri-eye-off-line' : 'ri-eye-line'} />
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-500 uppercase tracking-wider mb-1.5">Confirm Password</label>
              <input
                type={showPwd ? 'text' : 'password'}
                value={pwd2}
                onChange={(e) => setPwd2(e.target.value)}
                required
                minLength={8}
                placeholder="Re-type your new password"
                className={`${loginInputClass} ${ringClass}`}
              />
            </div>
            <button
              type="submit" disabled={submitting}
              className={`w-full disabled:opacity-60 text-white py-3 rounded-lg font-medium transition-all shadow-lg mt-2 ${btnClass}`}
            >
              {submitting ? 'Updating…' : 'Update Password'}
            </button>
          </form>
        </>
      )}
    </LoginLayout>
  );
}
