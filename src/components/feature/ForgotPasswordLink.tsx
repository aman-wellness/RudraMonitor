import { useState } from 'react';
import { supabase } from '@/lib/supabase';

type Accent = 'cyan' | 'violet' | 'purple';

const accentClasses: Record<Accent, { link: string; success: string }> = {
  cyan:   { link: 'text-cyan-600 hover:text-cyan-700',     success: 'text-cyan-700 bg-cyan-50 border-cyan-200' },
  violet: { link: 'text-violet-600 hover:text-violet-700', success: 'text-violet-700 bg-violet-50 border-violet-200' },
  purple: { link: 'text-purple-600 hover:text-purple-700', success: 'text-purple-700 bg-purple-50 border-purple-200' },
};

/**
 * Inline "Forgot password?" link for each portal's login page. Sends the
 * Supabase recovery email to whatever the user typed in the email field;
 * recovery email arrives via the Send Email Hook (Microsoft Graph API).
 *
 * The reset link in the email points at /reset-password — that page already
 * detects the user's app_role and routes them back to the right portal after
 * the password is set.
 */
export default function ForgotPasswordLink({
  email,
  accent = 'cyan',
}: { email: string; accent?: Accent }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const c = accentClasses[accent];

  const send = async () => {
    setMsg(null);
    const target = email.trim();
    if (!target) {
      setMsg({ kind: 'err', text: 'Enter your email above first, then click "Forgot password?".' });
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(target, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (error) setMsg({ kind: 'err', text: error.message });
    else setMsg({ kind: 'ok', text: `Reset link sent to ${target}. Check your inbox (and spam folder).` });
  };

  return (
    <div className="text-right -mt-1">
      <button
        type="button"
        onClick={send}
        disabled={busy}
        className={`text-xs font-medium ${c.link} disabled:opacity-50`}
      >
        {busy ? 'Sending…' : 'Forgot password?'}
      </button>
      {msg && (
        <p
          className={`mt-2 text-left text-xs px-3 py-2 rounded-lg border ${
            msg.kind === 'ok' ? c.success : 'text-red-600 bg-red-50 border-red-200'
          }`}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}
