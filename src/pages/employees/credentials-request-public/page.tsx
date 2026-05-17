// Public, unauthenticated route. Single-page form:
//   1. User enters their work email.
//   2. We resolve the org by matching domain against any connected directory
//      integration's primary_domain (no magic link).
//   3. On success the form expands with the available platform checklist.
//   4. Submit creates a credential_requests row → mails manager + IT.

import { useState } from 'react';

type ContextResp = {
  org_name: string;
  employee: { id: string; full_name: string; work_email: string } | null;
  manager_candidates: Array<{ row_id: string; display_name: string; work_email: string }>;
  default_manager_email: string | null;
  credentials: Array<{ id: string; platform_name: string; category: string | null; notes: string | null }>;
};

export default function PublicCredentialsRequest() {
  const [email, setEmail] = useState('');
  const [ctx, setCtx] = useState<ContextResp | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [managerEmails, setManagerEmails] = useState<Set<string>>(new Set());
  const [managerQ, setManagerQ] = useState('');
  const [customText, setCustomText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);

  const fetchCtx = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cred-request-submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: email.trim().toLowerCase(), action: 'context' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      const ctxResp = j as ContextResp;
      setCtx(ctxResp);
      // Pre-check the auto-resolved manager if one's on file. The requester
      // can still add more / swap.
      if (ctxResp.default_manager_email) {
        setManagerEmails(new Set([ctxResp.default_manager_email.toLowerCase()]));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

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
      const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cred-request-submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: email.trim().toLowerCase(),
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
        <h1 className="text-2xl font-poppins font-semibold text-white mb-1">Request submitted</h1>
        <p className="text-sm text-gray-400 mb-4">
          We've routed your request to {ctx?.employee?.id ? 'your manager (CC: IT team)' : 'the IT team'}.
          You'll receive the credentials in separate emails once approved.
        </p>
        <p className="text-xs text-gray-500">Reference: {submitted}</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-2xl font-poppins font-semibold text-white mb-1">Request software access</h1>
      <p className="text-sm text-gray-400 mb-5">
        Use your work email. Pick the platforms you need — your request will go to your manager (cc IT).
      </p>

      {err && <div className="mb-3 px-3 py-2 rounded-lg text-xs bg-rose-500/10 border border-rose-500/30 text-rose-300">{err}</div>}

      <form onSubmit={fetchCtx} className="space-y-3">
        <label className="block">
          <span className="block text-xs text-gray-400 mb-1">Work email</span>
          <div className="flex gap-2">
            <input type="email" required disabled={!!ctx} value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 px-3 py-2.5 bg-dark-900 border border-dark-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 disabled:opacity-60"
              placeholder="you@company.com" />
            {!ctx && (
              <button type="submit" disabled={busy || !email}
                className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm text-white font-medium whitespace-nowrap">
                {busy ? 'Checking…' : 'Continue'}
              </button>
            )}
            {ctx && (
              <button type="button" onClick={() => { setCtx(null); setPicked(new Set()); setCustomText(''); }}
                className="px-3 py-2.5 bg-dark-700 hover:bg-dark-600 rounded-lg text-xs text-white">
                Change
              </button>
            )}
          </div>
        </label>
      </form>

      {ctx && (
        <div className="mt-5 pt-5 border-t border-dark-700 space-y-4">
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-dark-900 flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-dark-800 border border-dark-700 rounded-2xl p-6 md:p-8 shadow-2xl">
        {children}
      </div>
    </div>
  );
}
