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
// TWO PATHS NOW, chosen with the toggle in the toolbar:
//
//   "In dashboard" (default) — a direct WebRTC peer connection to the agent,
//     rendered by RemoteStage. Screen comes over a video track, mouse/keyboard/
//     clipboard over a control DataChannel. The agent side of this
//     (webrtc_stream.rs + input.rs) was always in the tree; only the dashboard
//     half had been removed, which left agents remote-controllable with nothing
//     to control them from. No third-party client and nothing to license.
//
//   "RustDesk client" — the flow described above: mint a session, wait for
//     remote.ready, then hand the operator an ID and password for the desktop
//     RustDesk client. Kept because it carries file transfer and multi-monitor,
//     which the WebRTC path does not.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgents } from '@/lib/dataHooks';
import { supabase } from '@/lib/supabase';
import { edgeError } from '@/lib/livekit-client';
import RemoteStage from './RemoteStage';

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
  // Two independent remote paths, chosen here rather than by config:
  //   'webrtc'   — direct peer connection, screen + mouse/keyboard/clipboard in
  //                this tab. No third-party client, no relay to license.
  //   'rustdesk' — the Phase-2 flow, which hands the operator credentials for
  //                the desktop RustDesk client.
  // WebRTC is the default because it is the one that keeps the operator in the
  // dashboard, which is what this tab is for.
  const [mode, setMode] = useState<'webrtc' | 'rustdesk'>('webrtc');
  const [webrtcAgentId, setWebrtcAgentId] = useState<string | null>(null);
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
    ch.on('broadcast', { event: 'remote.ended' }, ({ payload }) => {
      // An agent-side abort ends the session just like an admin hang-up, so
      // without showing the reason the two are indistinguishable: the panel
      // just dropped back to Idle and the admin had no idea the agent had
      // failed, let alone that it was a missing rustdesk binary. Only surface
      // it when the agent ended it — an admin who clicked "End session" does
      // not need to be told they clicked it.
      const p = payload as { ended_by?: string; reason?: string | null };
      if (p.ended_by === 'agent' && p.reason) {
        setError(`Agent ended the session: ${p.reason}`);
      }
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
        throw new Error(await edgeError(resp, 'remote-session-start'));
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
    <div className="space-y-2.5">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            disabled={!!session || onlineAgents.length === 0}
            className="filter-date disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ minWidth: 190 }}
          >
            <option value="">
              {onlineAgents.length === 0 ? 'No agents reporting' : 'Select agent…'}
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
            className="filter-date disabled:opacity-50"
            style={{ width: 240 }}
          />
          {!session && !webrtcAgentId && (
            <div className="seg">
              {(['webrtc', 'rustdesk'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`seg-btn ${mode === m ? 'is-on' : ''}`}
                  title={m === 'webrtc'
                    ? 'Screen and input in this tab, over a direct connection'
                    : 'Hands you credentials for the desktop RustDesk client'}
                >
                  {m === 'webrtc' ? 'In dashboard' : 'RustDesk client'}
                </button>
              ))}
            </div>
          )}
          {!session && !webrtcAgentId && (
            <button
              onClick={() => {
                if (!selectedId) return;
                if (mode === 'webrtc') setWebrtcAgentId(selectedId);
                else void startSession();
              }}
              disabled={!selectedId}
              className="chip chip-success text-[10.5px] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <i className="ri-remote-control-2-line" />
              Start remote session
            </button>
          )}
          {session && (
            <button
              onClick={endSession}
              className="chip chip-danger text-[10.5px]"
            >
              <i className="ri-stop-circle-line" />
              End session
            </button>
          )}
        </div>
        <StatePill state={session?.state ?? 'idle'} />
      </div>

      {error && (
        <div className="banner">
          <span className="flex items-start gap-2 min-w-0">
            <i className="ri-error-warning-line text-[13px] t-danger mt-px" />
            <span className="text-[11.5px] t-danger">{error}</span>
          </span>
        </div>
      )}

      {webrtcAgentId ? (
        <RemoteStage
          agentId={webrtcAgentId}
          agentName={onlineAgents.find((a) => a.id === webrtcAgentId)?.name ?? 'Agent'}
          onClose={() => setWebrtcAgentId(null)}
        />
      ) : /* Same as Live: only claim a 16:9 stage once there's a session to show. */
      !session ? (
        <div className="panel p-10">
          <EmptyState />
        </div>
      ) : (
      <div className="panel aspect-video overflow-hidden relative">
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
      )}
    </div>
  );
}

function StatePill({ state }: { state: SessionState }) {
  const labels: Record<SessionState, [string, string]> = {
    idle:             ['Idle',               'var(--d-neutral)'],
    requesting:       ['Requesting…',        'var(--d-warning)'],
    awaiting_consent: ['Awaiting consent…',  'var(--d-warning)'],
    approved:         ['Starting RustDesk…', 'var(--d-warning)'],
    ready:            ['Active',             'var(--d-success)'],
    failed:           ['Failed',             'var(--d-danger)'],
    ended:            ['Ended',              'var(--d-neutral)'],
  };
  const [label, tone] = labels[state];
  const pulsing = ['requesting', 'awaiting_consent', 'approved', 'ready'].includes(state);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: tone }}>
      <span
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${pulsing ? 'animate-pulse' : ''}`}
        style={{ background: tone }}
      />
      {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="flex items-center justify-center">
      <div className="text-center max-w-md">
        <i className="ri-remote-control-2-line text-[24px] t3 block mb-2" />
        <p className="text-[12.5px] t2">
          Pick an agent and start a session to connect.
        </p>
        <p className="text-[11px] t3 mt-1.5 leading-relaxed">
          Unattended access is on by default — the session connects without a per-session prompt
          (consent is covered by your acceptable-use policy). To require an on-screen approval for a
          specific org or agent instead, add a <code className="t2">remote_permissions</code>{' '}
          row with <code className="t2">require_consent = true</code>.
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
        <div
          className="w-9 h-9 rounded-full mx-auto mb-3 animate-spin"
          style={{ border: '2px solid var(--d-line)', borderTopColor: 'var(--d-warning)' }}
        />
        <p className="text-[12.5px] t1 font-medium">{m.title}</p>
        <p className="text-[11px] t3 mt-1.5 leading-relaxed">{m.sub}</p>
      </div>
    </div>
  );
}

function ConnectionDetails({ session }: { session: ActiveSession }) {
  // No iframe URL configured → show the credentials prominently for use
  // with the desktop RustDesk client.
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="panel p-4 max-w-md w-full">
        <p className="text-[11.5px] t2 mb-3">
          Open the <strong className="t1">desktop RustDesk client</strong> on your machine and use
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
        <p className="text-[10.5px] t3 mt-3 leading-relaxed">
          Or set <code className="t2">VITE_RUSTDESK_WEB_URL</code> at build time to embed the
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
    <div className="flex items-center justify-between gap-3 py-2 hair-b last:border-b-0">
      <span className="label">{label}</span>
      <div className="flex items-center gap-1.5">
        <code className={`text-[11.5px] t1 ${mono ? 'font-mono' : ''}`}>{display}</code>
        {secret && (
          <button
            onClick={() => setRevealed((v) => !v)}
            className="icon-btn"
            title={revealed ? 'Hide' : 'Reveal'}
          >
            <i className={revealed ? 'ri-eye-off-line' : 'ri-eye-line'} />
          </button>
        )}
        <button
          onClick={() => void navigator.clipboard.writeText(value)}
          className="icon-btn"
          title="Copy"
        >
          <i className="ri-clipboard-line" />
        </button>
      </div>
    </div>
  );
}
