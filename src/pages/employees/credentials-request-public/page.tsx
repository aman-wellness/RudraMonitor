// Public, unauthenticated route. Two-step, email-verified flow:
//   1. User enters their work email → cred-request-start emails them a
//      single-use magic link (proves mailbox ownership; no data is returned
//      to an anonymous caller).
//   2. The link opens this page with ?t=<signed token>. Only then do we fetch
//      the platform checklist (cred-request-submit action:context) and let them
//      submit — both authenticated by the token, not by a typed-in email.
// SECURITY REVIEW C1: previously step 1 returned the org's credential inventory
// straight from an unverified email, so anyone who knew a company domain could
// read it. The token now gates every data path.

import { useState, useEffect, useCallback } from 'react';

type ContextResp = {
  org_name: string;
  employee: { id: string; full_name: string; work_email: string } | null;
  manager_candidates: Array<{ row_id: string; display_name: string; work_email: string }>;
  default_manager_email: string | null;
  credentials: Array<{ id: string; platform_name: string; category: string | null; notes: string | null }>;
};

const FN = (name: string) => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;

export default function PublicCredentialsRequest() {
  const token = new URLSearchParams(window.location.search).get('t') ?? '';
  const [email, setEmail] = useState('');
  const [linkSent, setLinkSent] = useState(false);
  const [ctx, setCtx] = useState<ContextResp | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(!!token);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [managerEmails, setManagerEmails] = useState<Set<string>>(new Set());
  const [managerQ, setManagerQ] = useState('');
  const [customText, setCustomText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);

  // Step 1 (no token): request a magic link. We never reveal whether the email
  // matched — the response is intentionally the same either way.
  const requestLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch(FN('cred-request-start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: email.trim().toLowerCase() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setLinkSent(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  // Step 2 (token present): load the checklist, authenticated by the token.
  const fetchCtx = useCallback(async () => {
    setLoadingCtx(true); setErr(null);
    try {
      const r = await fetch(FN('cred-request-submit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action: 'context' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      const ctxResp = j as ContextResp;
      setCtx(ctxResp);
      if (ctxResp.default_manager_email) {
        setManagerEmails(new Set([ctxResp.default_manager_email.toLowerCase()]));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoadingCtx(false); }
  }, [token]);

  useEffect(() => { if (token) void fetchCtx(); }, [token, fetchCtx]);

  const toggleManager = (email: string) => setManagerEmails((s) => {
    const lower = email.toLowerCase();
    const n = new Set(s);
    if (n.has(lower)) n.delete(lower); else n.add(lower);
    return n;
  });

  const filteredManagers = (ctx?.manager_candidates ?? []).filter((m) => {
    const q = managerQ.trim().toLowerCase();
    if (!q) return true;
    return m.display_name.toLowerCase().includes(q) || m.work_email.toLowerCase().includes(q);
  });

  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(FN('cred-request-submit'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          action: 'submit',
          credential_ids: [...picked],
          custom_text: customText.trim() || undefined,
          manager_emails: [...managerEmails],
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setSubmitted(j.request_id as string);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  if (submitted) {
    return (
      <Shell>
        <div className="text-center py-2">
          <div className="mx-auto w-14 h-14 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 grid place-items-center text-emerald-400 mb-4">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h1 className="text-xl font-poppins font-semibold text-white mb-1.5">Request submitted</h1>
          <p className="text-sm text-gray-400 leading-relaxed">
            We've routed your request to{' '}
            <span className="text-white">
              {ctx?.employee?.id ? 'your manager (CC: IT team)' : 'the IT team'}
            </span>.
            You'll receive the credentials in separate emails once approved.
          </p>
          <div className="mt-5 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-dark-800/80 border border-dark-700 text-[11px] text-gray-400">
            <span className="text-gray-500">Reference</span>
            <span className="font-mono text-gray-200 select-all">{submitted}</span>
          </div>
        </div>
      </Shell>
    );
  }

  // Step 1 — no token yet: ask for the work email and email a magic link.
  if (!token) {
    const displayEmail = email.trim().toLowerCase();
    return (
      <Shell>
        {/* Hero icon + heading. The shield here is intentional — this form
            is a credential request, and the visual has to reassure the
            employee that "give email → get link" is the safe path, not a
            phishing pattern. */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="grid place-items-center w-12 h-12 rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/30 text-emerald-400 mb-4">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h1 className="text-[22px] md:text-2xl font-poppins font-semibold text-white tracking-tight">
            Request software access
          </h1>
          <p className="text-sm text-gray-400 mt-1.5 max-w-sm">
            Sign in with your work email to see the platforms available for your role and request the ones you need.
          </p>
        </div>

        {err && (
          <div className="mb-4 px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
            <span className="mt-0.5">⚠</span>
            <span>{err}</span>
          </div>
        )}

        {linkSent ? (
          <div className="text-center py-2">
            <div className="mx-auto w-14 h-14 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 grid place-items-center text-emerald-400 mb-4">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
            </div>
            <h2 className="text-base font-medium text-white mb-1">Check your inbox</h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              If <strong className="text-white break-all">{displayEmail}</strong> matches an active employee,
              a secure sign-in link is on its way. It's valid for <strong className="text-white">30 minutes</strong>.
            </p>
            <p className="text-xs text-gray-500 mt-3">
              You can close this tab and continue from the email.
            </p>
          </div>
        ) : (
          <>
            <form onSubmit={requestLink} className="space-y-4">
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1.5 font-medium">Work email</span>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                      <polyline points="22,6 12,13 2,6" />
                    </svg>
                  </span>
                  <input
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full pl-9 pr-3 py-2.5 bg-dark-950 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 transition"
                    placeholder="you@company.com"
                  />
                </div>
              </label>
              <button
                type="submit"
                disabled={busy || !email}
                className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm text-white font-medium transition inline-flex items-center justify-center gap-2"
              >
                {busy ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Sending link…
                  </>
                ) : (
                  <>
                    Email me a secure link
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                  </>
                )}
              </button>
            </form>

            {/* Trust row. Three short bullets that explain why this flow is
                worth trusting — no password to steal, no list leaked to
                the internet, no session that lingers. */}
            <div className="mt-6 pt-5 border-t border-dark-700/60 grid grid-cols-3 gap-3 text-center">
              <TrustBullet
                icon={<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}
                label="Private list"
                hint="Verified employees only"
              />
              <TrustBullet
                icon={<><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 15 15"/></>}
                label="30-min link"
                hint="Expires automatically"
              />
              <TrustBullet
                icon={<><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>}
                label="No password"
                hint="Nothing to steal"
              />
            </div>
          </>
        )}
      </Shell>
    );
  }

  // Step 2 — token present: verifying, or the checklist, or an expired link.
  if (loadingCtx) {
    return <Shell><p className="text-sm text-gray-400">Verifying your link…</p></Shell>;
  }
  if (!ctx) {
    return (
      <Shell>
        <h1 className="text-xl font-poppins font-semibold text-white mb-2">Link expired</h1>
        <p className="text-sm text-gray-400">
          {err ?? 'This link is invalid or has expired.'}{' '}
          <a href="/r/credentials-request" className="text-emerald-400 underline">Start over</a> to get a new one.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-2xl font-poppins font-semibold text-white mb-1">Request software access</h1>
      <p className="text-sm text-gray-400 mb-5">
        Pick the platforms you need — your request will go to your manager (cc IT).
      </p>

      {err && <div className="mb-3 px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

      {(
        <div className="space-y-4">
          {ctx.org_name && (
            <p className="text-xs text-gray-500">
              Submitting to <strong className="text-white">{ctx.org_name}</strong>
              {ctx.employee && <> · recognised as <strong className="text-white">{ctx.employee.full_name}</strong></>}
            </p>
          )}

          <div>
            <p className="text-sm text-white mb-2">
              Pick your manager{managerEmails.size > 1 ? 's' : ''}
              {managerEmails.size > 0 && <span className="text-xs text-gray-500 ml-2">({managerEmails.size} selected)</span>}
            </p>
            <input
              value={managerQ}
              onChange={(e) => setManagerQ(e.target.value)}
              placeholder="Search by name or email…"
              className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 mb-2"
            />
            <div className="border border-dark-700 rounded-lg max-h-44 overflow-y-auto">
              {filteredManagers.length === 0 ? (
                <p className="px-3 py-3 text-center text-xs text-gray-500">
                  {ctx.manager_candidates.length === 0 ? 'No org users yet — try again after a directory sync.' : 'No match.'}
                </p>
              ) : filteredManagers.map((m) => {
                const checked = managerEmails.has(m.work_email.toLowerCase());
                return (
                  <label key={m.row_id} className="flex items-center gap-3 px-3 py-2 border-b border-dark-700/50 hover:bg-dark-700/30 cursor-pointer">
                    <input type="checkbox" checked={checked} onChange={() => toggleManager(m.work_email)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{m.display_name}</p>
                      <p className="text-xs text-gray-500 truncate">{m.work_email}</p>
                    </div>
                    {ctx.default_manager_email && ctx.default_manager_email.toLowerCase() === m.work_email.toLowerCase() && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">on file</span>
                    )}
                  </label>
                );
              })}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Approval mail goes to everyone selected. Any one of them can approve.
            </p>
          </div>

          <div>
            <p className="text-sm text-white mb-2">Pick platforms you need</p>
            <div className="border border-dark-700 rounded-lg max-h-72 overflow-y-auto">
              {ctx.credentials.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-gray-500">No platforms catalogued for your scope yet. Describe what you need below.</p>
              ) : ctx.credentials.map((c) => (
                <label key={c.id} className="flex items-start gap-3 px-3 py-2 border-b border-dark-700/50 hover:bg-dark-700/30 cursor-pointer">
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} className="mt-1" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white">{c.platform_name}</p>
                    {(c.category || c.notes) && <p className="text-xs text-gray-500">{[c.category, c.notes].filter(Boolean).join(' · ')}</p>}
                  </div>
                </label>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Anything else? (optional)</span>
            <textarea value={customText} onChange={(e) => setCustomText(e.target.value)}
              className="w-full px-3 py-2 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 h-24 resize-none"
              placeholder="e.g. I also need GA4 reporter access for marketing dashboards." />
          </label>

          <button onClick={submit} disabled={busy || (picked.size === 0 && !customText.trim())}
            className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium">
            {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </div>
      )}
    </Shell>
  );
}

function TrustBullet({ icon, label, hint }: { icon: React.ReactNode; label: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="grid place-items-center w-8 h-8 rounded-lg bg-dark-800 ring-1 ring-dark-700 text-gray-300">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </span>
      <span className="text-[11px] font-medium text-gray-200 leading-tight">{label}</span>
      <span className="text-[10px] text-gray-500 leading-tight">{hint}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-dark-950 text-white relative overflow-hidden flex flex-col">
      {/* Radial glow — subtle depth so the card sits ON the page instead of
          floating in a flat void. Two soft blobs, non-interactive. */}
      <div className="pointer-events-none absolute inset-0 [background:radial-gradient(60%_40%_at_50%_-10%,rgba(16,185,129,0.10),transparent),radial-gradient(50%_30%_at_10%_100%,rgba(59,130,246,0.08),transparent)]" />

      {/* Brand row — quietly places the request inside the Wellness Extract
          product so the employee can trust who's asking. */}
      <header className="relative z-10 px-6 md:px-10 py-5 flex items-center gap-2 text-sm text-gray-400">
        <span className="grid place-items-center w-7 h-7 rounded-md bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
        </span>
        <span className="font-medium tracking-wide text-white">Wellness Extract</span>
        <span className="text-gray-600">·</span>
        <span>Employee credential vault</span>
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center p-4 md:p-6">
        <div className="w-full max-w-md">
          <div className="bg-dark-900/80 backdrop-blur border border-dark-700/70 rounded-2xl p-7 md:p-8 shadow-2xl shadow-black/40">
            {children}
          </div>
        </div>
      </main>

      <footer className="relative z-10 px-6 md:px-10 py-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-500 border-t border-dark-800/50">
        <span>Secured by Wellness Extract · Data encrypted in transit and at rest.</span>
        <span>Need help? Reply to any credential email from your IT team.</span>
      </footer>
    </div>
  );
}
