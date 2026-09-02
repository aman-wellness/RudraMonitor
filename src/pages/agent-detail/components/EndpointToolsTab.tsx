// Endpoint Tools tab — per-agent silent execution of bundled maintenance
// scripts (Driver Update + Windows Optimizer). Admin clicks Run; edge fn
// `agent-run-tool` inserts a tool_runs row + Realtime-broadcasts to the
// agent; agent executes the script silently and POSTs back to
// `agent-tool-result`. This component subscribes to postgres_changes on
// tool_runs and renders live status + a download link for the report.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type ToolKind = 'driver_updater' | 'windows_optimizer';
type ToolState = 'pending' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';

interface ToolRun {
  id: string;
  agent_id: string;
  tool_kind: ToolKind;
  state: ToolState;
  exit_code: number | null;
  duration_ms: number | null;
  stdout_tail: string | null;
  report_path: string | null;
  created_at: string;
  completed_at: string | null;
}

interface Props {
  agentId: string;
  agentName: string;
  osType: string;
}

const TOOL_LABEL: Record<ToolKind, string> = {
  driver_updater: 'Driver Update',
  windows_optimizer: 'Windows Optimizer',
};

const TOOL_ICON: Record<ToolKind, string> = {
  driver_updater: 'ri-download-cloud-line',
  windows_optimizer: 'ri-tools-line',
};

const TOOL_DESC: Record<ToolKind, string> = {
  driver_updater:
    'Scans installed drivers and installs Windows-Update-provided driver updates via PSWindowsUpdate. Produces InstalledDrivers.csv. Typically ~2-5 min.',
  windows_optimizer:
    'Clears temp/prefetch/Windows-Update-cache/browser caches, runs DISM + sfc + chkdsk + Optimize-Volume. Produces Cleanup_Report.txt. Typically 20-30 min.',
};

export default function EndpointToolsTab({ agentId, agentName, osType }: Props) {
  const [runs, setRuns] = useState<ToolRun[]>([]);
  const [busy, setBusy] = useState<ToolKind | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<ToolKind | null>(null);
  // Which run's details drawer is open. Drives the expanded stdout_tail row
  // rendered under the run — that's the only place the "why did it fail"
  // text lives, and prior UI hid it entirely.
  const [expanded, setExpanded] = useState<string | null>(null);

  const isWindows = osType.toLowerCase().includes('windows');

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('tool_runs')
      .select('id, agent_id, tool_kind, state, exit_code, duration_ms, stdout_tail, report_path, created_at, completed_at')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(20);
    setRuns((data ?? []) as ToolRun[]);
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  // Live-update run rows while one is in flight. Every INSERT/UPDATE on
  // tool_runs for this agent triggers a fresh load — cheap because the
  // list is capped at 20 rows.
  useEffect(() => {
    const ch = supabase
      .channel(`tool-runs-${agentId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tool_runs', filter: `agent_id=eq.${agentId}` },
        () => { void load(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [agentId, load]);

  const runTool = async (tool: ToolKind) => {
    setConfirm(null);
    setBusy(tool);
    setMsg({ kind: 'info', text: `Sending run request to ${agentName}…` });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/agent-run-tool`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session?.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agent_id: agentId, tool_kind: tool }),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setMsg({
        kind: 'ok',
        text: `Queued. Watch the "Recent runs" table below for live status.`,
      });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const downloadReport = async (path: string) => {
    const { data, error } = await supabase.storage
      .from('tool-run-reports')
      .createSignedUrl(path, 60 * 10); // 10 min
    if (error || !data) {
      setMsg({ kind: 'err', text: `signed URL: ${error?.message ?? 'no data'}` });
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  return (
    <div className="space-y-4 mt-4">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Endpoint Tools</h2>
        <p className="text-xs text-gray-500">
          Silently run maintenance scripts on {agentName}'s PC. The user won't see any window, popup, or notification.
        </p>
      </div>

      {!isWindows && (
        <div className="border border-amber-500/40 bg-amber-500/10 rounded-xl p-3 text-sm text-amber-300">
          Endpoint tools are Windows-only. This agent reports OS: {osType || 'unknown'}.
        </div>
      )}

      {msg && (
        <div className={`border rounded-xl p-3 text-sm ${
          msg.kind === 'ok'  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : msg.kind === 'err' ? 'border-red-500/40 bg-red-500/10 text-red-300'
          :                       'border-blue-500/40 bg-blue-500/10 text-blue-300'
        }`}>{msg.text}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(['driver_updater', 'windows_optimizer'] as ToolKind[]).map((tool) => (
          <div key={tool} className="bg-dark-800 border border-dark-700 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-lg bg-blue-500/15 text-blue-400 flex items-center justify-center">
                <i className={`${TOOL_ICON[tool]} text-lg`} />
              </div>
              <h3 className="text-sm font-semibold text-white">{TOOL_LABEL[tool]}</h3>
            </div>
            <p className="text-[11.5px] text-gray-400 mb-3 leading-relaxed">{TOOL_DESC[tool]}</p>
            <button
              type="button"
              onClick={() => setConfirm(tool)}
              disabled={!isWindows || busy !== null}
              className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-dark-600 disabled:text-gray-500 rounded-lg text-white text-xs font-medium"
              title={!isWindows ? 'Windows agents only' : undefined}
            >
              {busy === tool ? 'Sending…' : `Run ${TOOL_LABEL[tool]}`}
            </button>
          </div>
        ))}
      </div>

      {/* Confirmation modal. Inline to avoid pulling a modal component. */}
      {confirm && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 max-w-md w-full space-y-3">
            <h3 className="text-base font-semibold text-white">Run {TOOL_LABEL[confirm]}?</h3>
            <p className="text-sm text-gray-300 leading-relaxed">
              This runs <strong className="text-white">silently in the background</strong> on {agentName}'s PC.
              The user will not see any window, popup, or notification.
              {confirm === 'windows_optimizer' && (
                <> This particular tool typically takes <strong className="text-white">20-30 minutes</strong> to complete.</>
              )}
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 rounded-lg text-white text-xs"
              >Cancel</button>
              <button
                type="button"
                onClick={() => void runTool(confirm)}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-white text-xs font-medium"
              >Run now</button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-dark-700">
          <h3 className="text-sm font-semibold text-white">Recent runs</h3>
        </div>
        {runs.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">No runs yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-dark-900/50 text-xs uppercase text-gray-400">
                <tr>
                  <th className="p-2.5 text-left">Tool</th>
                  <th className="p-2.5 text-left">State</th>
                  <th className="p-2.5 text-left">Started</th>
                  <th className="p-2.5 text-right">Duration</th>
                  <th className="p-2.5 text-right">Exit</th>
                  <th className="p-2.5 text-right">Report</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const isOpen = expanded === r.id;
                  const failed = r.state === 'failed' || r.state === 'timed_out' || r.state === 'cancelled';
                  return (
                    <>
                      <tr
                        key={r.id}
                        className={`border-t border-dark-700 ${r.stdout_tail ? 'cursor-pointer hover:bg-dark-900/40' : ''}`}
                        onClick={() => r.stdout_tail && setExpanded(isOpen ? null : r.id)}
                      >
                        <td className="p-2.5 text-white">
                          <span className="inline-flex items-center gap-1.5">
                            {r.stdout_tail && (
                              <span className={`text-gray-500 text-xs transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                            )}
                            {TOOL_LABEL[r.tool_kind]}
                          </span>
                        </td>
                        <td className="p-2.5">
                          <StatePill state={r.state} />
                          {failed && r.stdout_tail && !isOpen && (
                            <span className="ml-2 text-[10px] text-gray-500">click for details</span>
                          )}
                        </td>
                        <td className="p-2.5 text-gray-400 text-xs">{new Date(r.created_at).toLocaleString()}</td>
                        <td className="p-2.5 text-right text-gray-400 text-xs tnum">
                          {r.duration_ms === null ? '—' : fmtDuration(r.duration_ms)}
                        </td>
                        <td className="p-2.5 text-right text-gray-400 text-xs tnum">
                          {r.exit_code === null ? '—' : r.exit_code}
                        </td>
                        <td className="p-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                          {r.report_path ? (
                            <button
                              type="button"
                              onClick={() => void downloadReport(r.report_path!)}
                              className="text-xs text-blue-400 hover:underline"
                            >Download</button>
                          ) : <span className="text-xs text-gray-500">—</span>}
                        </td>
                      </tr>
                      {isOpen && r.stdout_tail && (
                        <tr key={`${r.id}-details`} className="bg-dark-900/60">
                          <td colSpan={6} className="p-3">
                            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                              {failed ? 'Failure reason (last output from agent)' : 'Last output from agent'}
                            </div>
                            <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words leading-relaxed max-h-72 overflow-y-auto font-mono bg-dark-950/50 p-2.5 rounded border border-dark-700">
                              {r.stdout_tail}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatePill({ state }: { state: ToolState }) {
  const map: Record<ToolState, { text: string; cls: string }> = {
    pending:   { text: '· Pending', cls: 'text-blue-400' },
    running:   { text: '· Running…', cls: 'text-blue-400' },
    succeeded: { text: '✓ Succeeded', cls: 'text-emerald-400' },
    failed:    { text: '✗ Failed',    cls: 'text-red-400' },
    timed_out: { text: '⏱ Timed out', cls: 'text-amber-400' },
    cancelled: { text: '⊘ Cancelled', cls: 'text-gray-400' },
  };
  const { text, cls } = map[state];
  return <span className={`text-xs ${cls}`}>{text}</span>;
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
