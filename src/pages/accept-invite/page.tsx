import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';

/**
 * /accept-invite?email=admin@example.com
 *
 * Invitee opens this from the email. They enter the 6-digit OTP + a new
 * password. We verify server-side (accept-invite-verify), then sign them
 * in with that password and route through /post-login.
 */
export default function AcceptInvitePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [otp, setOtp] = useState('');
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Pre-fill email from URL if present; lock it so the invitee can't pretend
  // to be someone else.
  useEffect(() => {
    const e = params.get('email');
    if (e) setEmail(e);
  }, [params]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.includes('@')) { setError('Enter your invite email.'); return; }
    if (!/^\d{6}$/.test(otp)) { setError('Enter the 6-digit code from the email.'); return; }
    if (pwd.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (pwd !== pwd2) { setError('Passwords do not match.'); return; }

    setSubmitting(true);
    try {
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/accept-invite-verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email, otp, password: pwd }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Could not accept invite');

      // Sign the invitee in with their new password and let /post-login
      // route them to /dashboard (the link RPC there is a second safety net).
      const { error: signErr } = await supabase.auth.signInWithPassword({ email, password: pwd });
      if (signErr) throw new Error(signErr.message);

      setSuccess(true);
      setTimeout(() => navigate('/post-login', { replace: true }), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8 bg-dark-950">
      <div className="w-full max-w-md bg-dark-900 border border-dark-700 rounded-2xl p-7">
        <div className="text-center mb-6">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
            <i className="ri-mail-check-line text-2xl text-emerald-400" />
          </div>
          <h1 className="text-lg font-semibold text-white">Accept your invite</h1>
          <p className="text-xs text-gray-500 mt-1">
            Enter the 6-digit code from your invite email and set a password.
          </p>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>
        )}
        {success && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
            Verified — signing you in…
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              readOnly={!!params.get('email')}
              className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 read-only:opacity-70"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">6-digit code</label>
            <input
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              required
              className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 tracking-[0.5em] font-mono text-center"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">New password</label>
            <div className="relative">
              <input
                type={showPwd ? 'text' : 'password'}
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="At least 8 characters"
                required
                className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 pr-11 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
              />
              <button type="button" onClick={() => setShowPwd(!showPwd)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                <i className={showPwd ? 'ri-eye-off-line' : 'ri-eye-line'} />
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">Confirm password</label>
            <input
              type={showPwd ? 'text' : 'password'}
              value={pwd2}
              onChange={(e) => setPwd2(e.target.value)}
              placeholder="Re-enter password"
              required
              className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-dark-950 font-medium py-2.5 rounded-lg transition-colors mt-2"
          >
            {submitting ? 'Verifying…' : 'Verify & sign in'}
          </button>
        </form>

        <p className="text-[11px] text-gray-500 text-center mt-5">
          Code expired or wrong email? Ask your admin to <strong>Resend invite</strong> from the Users panel.{' '}
          <Link to="/login" className="text-emerald-400 hover:text-emerald-300">Go to login</Link>
        </p>
      </div>
    </div>
  );
}
