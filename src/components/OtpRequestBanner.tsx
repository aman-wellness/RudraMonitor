// Realtime banner that pops at the top of every dashboard page whenever
// the auto-invoice browser-agent worker is stuck on an OTP screen. Admin
// types the 6-digit code right here and the worker resumes within ~5 s.
//
// Subscribes to the `otp_requests` table via Supabase Realtime, filtered
// to the current org. Server-side RLS ensures only org members ever see
// these rows — we don't filter further here, just render what comes in.

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';

interface OtpRow {
  id: string;
  org_id: string;
  credential_id: string;
  job_id: string;
  prompt: string;
  status: 'pending' | 'fulfilled' | 'expired' | 'cancelled';
  expires_at: string;
  created_at: string;
}

export default function OtpRequestBanner() {
  const { user, organization } = useAuth();
  const currentOrgId = organization?.id ?? null;
  const [pending, setPending] = useState<OtpRow[]>([]);
  const [active, setActive] = useState<OtpRow | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Initial load + realtime subscription.
  useEffect(() => {
    if (!currentOrgId || !user) return;

    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('otp_requests')
        .select('id, org_id, credential_id, job_id, prompt, status, expires_at, created_at')
        .eq('org_id', currentOrgId)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });
      if (!cancelled) setPending((data ?? []) as OtpRow[]);
    })();

    const ch = supabase
      .channel(`otp:${currentOrgId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'otp_requests', filter: `org_id=eq.${currentOrgId}` },
        (payload) => {
          setPending((prev) => {
            const next = prev.filter((r) => r.id !== (payload.new as OtpRow)?.id && r.id !== (payload.old as OtpRow)?.id);
            const row = payload.new as OtpRow | undefined;
            if (row && row.status === 'pending' && new Date(row.expires_at) > new Date()) next.unshift(row);
            return next;
          });
        },
      )
      .subscribe();
    channelRef.current = ch;

    return () => {
      cancelled = true;
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, [currentOrgId, user]);

  // Auto-prune expired requests every 15 s.
  useEffect(() => {
    const t = setInterval(() => {
      setPending((prev) => prev.filter((r) => new Date(r.expires_at) > new Date()));
    }, 15000);
    return () => clearInterval(t);
  }, []);

  const top = pending[0] ?? null;
  const expiresIn = useMemo(() => {
    if (!top) return 0;
    return Math.max(0, Math.floor((new Date(top.expires_at).getTime() - Date.now()) / 1000));
  }, [top, pending]);

  if (!top) return null;

  const startSubmit = () => {
    setActive(top);
    setCode('');
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!active || !/^\d{4,8}$/.test(code)) return;
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-otp-submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ request_id: active.id, code, via: 'dashboard' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      // Remove locally — realtime update will confirm.
      setPending((prev) => prev.filter((p) => p.id !== active.id));
      setActive(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3">
      <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
          <i className="ri-shield-keyhole-line text-amber-300 text-lg" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-amber-100 font-medium">
            OTP needed: <span className="text-amber-200">{top.prompt}</span>
            {pending.length > 1 && <span className="text-xs text-amber-300/70 ml-2">+ {pending.length - 1} more</span>}
          </p>
          <p className="text-[11px] text-amber-300/70 mt-0.5">
            Expires in {Math.floor(expiresIn / 60)}m {expiresIn % 60}s. The auto-invoice fetcher is paused waiting on this code.
          </p>

          {active?.id !== top.id ? (
            <button onClick={startSubmit} className="mt-2 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold">
              Enter OTP
            </button>
          ) : (
            <form onSubmit={submit} className="mt-2 flex items-center gap-2">
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                inputMode="numeric"
                placeholder="123456"
                autoComplete="one-time-code"
                className="px-3 py-1.5 rounded-lg bg-dark-900 border border-amber-500/40 text-white text-base tracking-[0.3em] font-mono w-32 text-center outline-none"
              />
              <button type="submit" disabled={!/^\d{4,8}$/.test(code) || busy} className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold disabled:opacity-40">
                {busy ? '…' : 'Submit'}
              </button>
              <button type="button" onClick={() => setActive(null)} className="px-2 py-1.5 rounded-lg text-amber-300/80 hover:text-amber-200 text-xs">
                Cancel
              </button>
              {error && <span className="text-xs text-rose-300 ml-1">{error}</span>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
