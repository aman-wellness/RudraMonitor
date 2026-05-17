// Public landing page after a manager/IT clicks an approve/reject magic link
// from email. The edge function does the state transition then 303-redirects
// here with `?status=` and `?msg=`. We just render a nice confirmation.

import { useMemo } from 'react';

type Status = 'ok' | 'expired' | 'stale' | 'error' | string;

const STATUS_META: Record<string, { title: string; tint: string; icon: string; bg: string }> = {
  ok:      { title: 'All set',         tint: 'text-emerald-400', icon: 'ri-check-line',    bg: 'bg-emerald-500/15' },
  expired: { title: 'Link expired',    tint: 'text-amber-400',   icon: 'ri-time-line',     bg: 'bg-amber-500/15' },
  stale:   { title: 'Already actioned', tint: 'text-blue-400',    icon: 'ri-information-line', bg: 'bg-blue-500/15' },
  error:   { title: 'Something went wrong', tint: 'text-rose-400', icon: 'ri-close-line', bg: 'bg-rose-500/15' },
};

export default function CredentialsDecisionResult() {
  const { status, msg } = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    return {
      status: (q.get('status') ?? 'ok') as Status,
      msg: q.get('msg') ?? '',
    };
  }, []);

  const meta = STATUS_META[status] ?? STATUS_META.ok;

  return (
    <div className="min-h-screen bg-dark-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-dark-800 border border-dark-700 rounded-2xl shadow-2xl overflow-hidden">
        <div className={`${meta.bg} px-6 py-8 flex flex-col items-center text-center`}>
          <div className={`w-14 h-14 rounded-full ${meta.bg} ${meta.tint} flex items-center justify-center mb-3 border border-current/30`}>
            <i className={`${meta.icon} text-3xl`} />
          </div>
          <h1 className={`text-2xl font-poppins font-semibold ${meta.tint}`}>{meta.title}</h1>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
            {msg || (status === 'ok' ? 'Your decision has been recorded.' : 'Please contact your administrator.')}
          </p>

          <div className="pt-4 border-t border-dark-700 flex items-center justify-between">
            <p className="text-xs text-gray-500">Rudrans</p>
            <button onClick={() => window.close()} className="text-xs text-emerald-400 hover:text-emerald-300">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
