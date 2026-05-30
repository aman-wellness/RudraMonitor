// Remote Desktop tab — RustDesk-backed (Phase-2 spec).
//
// Replaces the legacy LiveKit/WebRTC-DataChannel implementation. RustDesk
// owns the entire mouse/keyboard/clipboard/file-transfer/multi-monitor
// stack, so this component is just a thin orchestration layer:
//
//   1. Admin picks an online agent → click "Start Remote Session".
//   2. POST /functions/v1/remote-session-start → backend mints a session
//      row + JWT and broadcasts `remote.request` on `agent:<id>`.
//   3. Subscribe to `session:<id>` Realtime channel; wait for
//      `remote.ready` with the rustdesk_id (the agent's 9-digit ID).
//   4. Render the rustdesk_id + one-time password OR an embedded
//      RustDesk web-client iframe (if VITE_RUSTDESK_WEB_URL is set).
//   5. "End Session" → POST /functions/v1/remote-session-end; backend
//      broadcasts `remote.ended` to both sides.
//
// The component never touches WebRTC or DataChannels — all input I/O
// happens inside the RustDesk client/host pair via its own relay
// protocol (TCP 21115/21116/21117, optionally tunnelled over WSS).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgents } from '@/lib/dataHooks';
import { supabase } from '@/lib/supabase';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string) ?? '';
const ANON_KEY     = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? '';
// If set, we embed the RustDesk web client in an iframe pointed at this
// URL. The iframe receives ?id=&pwd=&relay= in the hash. Unset → the
// admin uses the desktop RustDesk client with the displayed credentials.
const RUSTDESK_WEB_URL = (import.meta.env.VITE_RUSTDESK_WEB_URL as string) ?? '';

type SessionState =
  | 'idle'
  | 'requesting'
  | 'awaiting_consent'
  | 'approved'
  | 'ready'
  | 'failed'
  | 'ended';

interface ActiveSession {
  session_id: string;
  rustdesk_server: string;
  session_token: string;
  rustdesk_id?: string;
  rustdesk_pass?: string;
  state: SessionState;
}

export default function RemoteTab() {
  const { agents } = useAgents();
  const onlineAgents = useMemo(
    () => agents.filter((a) => a.status !== 'offline'),
    [agents],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason]   = useState('');
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const channelRef            = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Subscribe to session:<id> Realtime channel for ready / ended / decision
  // broadcasts. Auto-tears down on unmount.
  useEffect(() => {
    if (!session?.session_id) return;
    const ch = supabase.channel(`session:${session.session_id}`);
    ch.on('broadcast', { event: 'remote.consent_decision' }, ({ payload }) => {
      const p = payload as { decision: string };
      if (p.decision === 'deny') {
        setError('Employee declined the session');
        setSession((s) => (s ? { ...s, state: 'failed' } : s));
      } else {
        setSession((s) => (s ? { ...s, state: 'approved' } : s));
      }
    });
    ch.on('broadcast', { event: 'remote.ready' }, ({ payload }) => {
      const p = payload as { rustdesk_id: string; rustdesk_pass?: string | null };
      setSession((s) => (s ? {
        ...s,
        rustdesk_id: p.rustdesk_id,
        rustdesk_pass: p.rustdesk_pass ?? undefined,
        state: 'ready',
      } : s));
    });
    ch.on('broadcast', { event: 'remote.ended' }, () => {
      setSession((s) => (s ? { ...s, state: 'ended' } : s));
      setTimeout(() => setSession(null), 1500);
    });
    void ch.subscribe();
    channelRef.current = ch;
    return () => {
      void supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [session?.session_id]);

  const startSession = async () => {
    if (!selectedId) return;
    setError(null);
    setSession({
      session_id: '', rustdesk_server: '', session_token: '',
      state: 'requesting',
    });
    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      if (!authSession?.access_token) throw new Error('not signed in');
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/remote-session-start`, {
        method: 'POST',
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${authSession.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: selectedId,
          reason: reason.trim() || undefined,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`remote-session-start ${resp.status}: ${body}`);
      }
      const r = await resp.json() as {
        session_id: string;
        rustdesk_server: string;
        session_token: string;
        state: string;
      };
      // Initial state from the edge fn: 'requested' (consent_pending) OR
      // 'approved' (auto-approve). 'ready' arrives later via broadcast.
      const initial: SessionState =
        r.state === 'approved' ? 'approved' : 'awaiting_consent';
      setSession({
        session_id: r.session_id,
        rustdesk_server: r.rustdesk_server,
        session_token: r.session_token,
        state: initial,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSession(null);
    }
  };

  const endSession = async () => {
    if (!session?.session_id) return;
    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      if (!authSession?.access_token) return;
      await fetch(`${SUPABASE_URL}/functions/v1/remote-session-end`, {
        method: 'POST',
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${authSession.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: session.session_id,
          reason: 'admin ended',
        }),
      });
    } catch { /* best-effort */ }
    setSession(null);
  };

  // Tear down on tab close so we don't leave a session 'publishing'
  // forever if the admin navigates away.
  useEffect(() => {
    const beforeUnload = () => {
      if (session?.session_id) {
        navigator.sendBeacon?.(
          `${SUPABASE_URL}/functions/v1/remote-session-end`,
          new Blob([JSON.stringify({
            session_id: session.session_id, reason: 'tab closed',
          })], { type: 'application/json' }),
        );
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [session?.session_id]);

  const iframeUrl = session?.state === 'ready' && session.rustdesk_id && RUSTDESK_WEB_URL
    ? `${RUSTDESK_WEB_URL}#id=${session.rustdesk_id}&pwd=${encodeURIComponent(session.rustdesk_pass ?? '')}&relay=${encodeURIComponent(session.rustdesk_server)}`
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            disabled={!!session || onlineAgents.length === 0}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">
              {onlineAgents.length === 0 ? 'No online agents' : 'Select agent…'}
            </option>
            {onlineAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.machine})
              </option>
            ))}
          </select>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (shown to employee)"
            disabled={!!session}
            maxLength={200}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none disabled:opacity-50 w-72"
          />
          {!session && (
            <button
              onClick={startSession}
              disabled={!selectedId}
              className="px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <i className="ri-remote-control-2-line mr-1" />
              Start Remote Session
            </button>
          )}
          {session && (
            <button
              onClick={endSession}
              className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-xs font-medium"
            >
              End Session
            </button>
          )}
        </div>
        <StatePill state={session?.state ?? 'idle'} />
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="aspect-video bg-dark-900 border border-dark-700 rounded-xl overflow-hidden relative">
        {!session && (
          <EmptyState />
        )}
        {session && session.state !== 'ready' && (
          <PendingState state={session.state} />
        )}
        {session?.state === 'ready' && (
          iframeUrl ? (
            <iframe
              src={iframeUrl}
              className="absolute inset-0 w-full h-full border-0"
              allow="clipboard-read; clipboard-write; fullscreen"
              title="RustDesk remote session"
            />
          ) : (
            <ConnectionDetails session={session} />
          )
        )}
      </div>
    </div>
  );
}

function StatePill({ state }: { state: SessionState }) {
  const labels: Record<SessionState, [string, string]> = {
    idle:             ['Idle',                'bg-dark-800 text-gray-400'],
    requesting:       ['Requesting…',         'bg-amber-500/15 text-amber-300'],
    awaiting_consent: ['Awaiting consent…',   'bg-amber-500/15 text-amber-300'],
    approved:         ['Starting RustDesk…',  'bg-amber-500/15 text-amber-300'],
    ready:            ['Active',              'bg-emerald-500/15 text-emerald-300'],
    failed:           ['Failed',              'bg-red-500/15 text-red-300'],
    ended:            ['Ended',               'bg-gray-500/15 text-gray-300'],
  };
  const [label, cls] = labels[state];
  const pulsing = ['requesting','awaiting_consent','approved','ready'].includes(state);
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${pulsing ? 'animate-pulse' : ''}`} />
      {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="text-center max-w-md">
        <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
          <i className="ri-remote-control-2-line text-3xl" />
        </span>
        <p className="text-sm text-gray-400">
          Pick an online agent and click <strong>Start Remote Session</strong> to request remote control.
        </p>
        <p className="text-[11px] text-gray-600 mt-2">
          The employee will see a consent prompt on their machine. Approval lasts 8 hours by default
          (configurable per-agent in Admin → Integrations).
        </p>
      </div>
    </div>
  );
}

function PendingState({ state }: { state: SessionState }) {
  const messages: Partial<Record<SessionState, { title: string; sub: string }>> = {
    requesting: {
      title: 'Creating session…',
      sub: 'Asking the backend to mint a session token.',
    },
    awaiting_consent: {
      title: 'Waiting for employee approval',
      sub: 'A consent prompt is showing on the agent\'s machine. The employee has 60 seconds to allow or deny.',
    },
    approved: {
      title: 'Starting the RustDesk host…',
      sub: 'The agent is launching its rustdesk subprocess and registering with the relay.',
    },
    failed: {
      title: 'Session failed',
      sub: 'See the error message above for details.',
    },
    ended: {
      title: 'Session ended',
      sub: 'Connection closed.',
    },
  };
  const m = messages[state];
  if (!m) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="w-10 h-10 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin mx-auto mb-4" />
        <p className="text-sm text-gray-200 font-medium">{m.title}</p>
        <p className="text-xs text-gray-500 mt-1.5">{m.sub}</p>
      </div>
    </div>
  );
}

function ConnectionDetails({ session }: { session: ActiveSession }) {
  // No iframe URL configured → show the credentials prominently for use
  // with the desktop RustDesk client.
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="bg-dark-800/80 border border-dark-700 rounded-xl p-6 max-w-md w-full">
        <p className="text-xs text-gray-400 mb-4">
          Open the <strong className="text-white">desktop RustDesk client</strong> on your machine and use
          these credentials to connect:
        </p>
        <Field label="Relay" value={session.rustdesk_server} />
        <Field label="ID"    value={session.rustdesk_id ?? '—'} mono />
        <Field
          label="Password"
          value={session.rustdesk_pass ?? '(set by RustDesk on first run — see the ID window on agent machine)'}
          mono
          secret={!!session.rustdesk_pass}
        />
        <p className="text-[11px] text-gray-600 mt-4">
          Or set <code className="text-gray-400">VITE_RUSTDESK_WEB_URL</code> at build time to embed the
          RustDesk web client directly in this iframe.
        </p>
      </div>
    </div>
  );
}

function Field({ label, value, mono, secret }: { label: string; value: string; mono?: boolean; secret?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const display = secret && !revealed ? '•'.repeat(Math.min(16, value.length)) : value;
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-dark-700/50 last:border-b-0">
      <span className="text-[11px] uppercase tracking-wider text-gray-500">{label}</span>
      <div className="flex items-center gap-1.5">
        <code className={`text-xs text-gray-200 ${mono ? 'font-mono' : ''}`}>{display}</code>
        {secret && (
          <button
            onClick={() => setRevealed((v) => !v)}
            className="p-1 rounded hover:bg-dark-700 text-gray-500 hover:text-gray-300"
            title={revealed ? 'Hide' : 'Reveal'}
          >
            <i className={revealed ? 'ri-eye-off-line' : 'ri-eye-line'} />
          </button>
        )}
        <button
          onClick={() => void navigator.clipboard.writeText(value)}
          className="p-1 rounded hover:bg-dark-700 text-gray-500 hover:text-gray-300"
          title="Copy"
        >
          <i className="ri-clipboard-line" />
        </button>
      </div>
    </div>
  );
}
