// Public magic-link OTP responder. Lands at /otp/:requestId?token=…
//
// No login required — the magic token is verified server-side via sha-256
// comparison against otp_requests.magic_token_hash. Single-use, 5-min expiry.
// We never expose the request body to anyone but the linked admin.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

export default function OtpRespond() {
  const { requestId = '' } = useParams<{ requestId: string }>();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sent' | 'error' | 'expired'>('idle');
  const [error, setError] = useState<string | null>(null);

  const ok = useMemo(() => /^\d{4,8}$/.test(code), [code]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok || !requestId || !token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-otp-submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, token, code, via: 'magic_link' }),
      });
      const j = await r.json();
      if (r.status === 410) {
        setStatus('expired');
      } else if (!r.ok) {
        throw new Error(j.error ?? `${r.status}`);
      } else {
        setStatus('sent');
      }
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-dark-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-dark-800 border border-dark-700 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
            <i className="ri-shield-check-line text-emerald-400 text-xl" />
          </div>
          <div>
            <h1 className="text-white text-lg font-semibold">Enter OTP</h1>
            <p className="text-xs text-gray-400">Rudrans Auto-Invoice fetcher needs this code to continue.</p>
          </div>
        </div>

        {status === 'sent' && (
          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-4 text-emerald-300 text-sm">
            <i className="ri-check-line mr-1" /> OTP submitted. The fetcher will pick up the code within seconds.
            You can close this tab.
          </div>
        )}

        {status === 'expired' && (
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-4 text-amber-300 text-sm">
            <i className="ri-time-line mr-1" /> This link has expired (links are valid for 5 minutes). The fetcher
            will retry on the next run — or request a new OTP from the Credentials Vault.
          </div>
        )}

        {(status === 'idle' || status === 'error') && (
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="text-xs text-gray-400 mb-2 block">Authenticator / OTP code</span>
              <input
                ref={inputRef}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                inputMode="numeric"
                pattern="\d{4,8}"
                placeholder="123456"
                autoComplete="one-time-code"
                className="w-full px-4 py-3 rounded-lg bg-dark-900 border border-dark-700 text-white text-2xl tracking-[0.4em] font-mono text-center focus:border-emerald-500 outline-none"
              />
            </label>

            {error && (
              <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-3 text-rose-300 text-xs">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!ok || busy}
              className="w-full py-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold disabled:opacity-40"
            >
              {busy ? 'Submitting…' : 'Submit OTP'}
            </button>

            <p className="text-[11px] text-gray-500 text-center pt-2">
              Single-use, expires in 5 minutes. Sent only to listed OTP admins.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
