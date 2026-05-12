import { useEffect, useMemo, useState } from 'react';
import AdminLayout from '../AdminLayout';
import { supabase } from '@/lib/supabase';

type Stat = {
  organization_id: string;
  org_name: string;
  partner_name: string | null;
  agent_count: number;
  screenshot_count: number;
  screenshot_bytes: number;
  video_count: number;
  video_bytes: number;
  activity_log_rows: number;
  metric_rows: number;
  alert_rows: number;
  total_bytes: number;
};

const KIND_META: Array<{ key: string; label: string; description: string }> = [
  { key: 'screenshots',    label: 'Screenshots',    description: 'Image files in the screenshots bucket' },
  { key: 'videos',         label: 'Videos',         description: 'Video files in the videos bucket' },
  { key: 'activity_logs',  label: 'Activity Logs',  description: 'Per-window activity (apps, URLs, durations)' },
  { key: 'system_metrics', label: 'System Metrics', description: 'CPU/RAM/disk samples' },
  { key: 'alerts',         label: 'Alerts',         description: 'Productivity / DLP alert rows' },
];

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

export default function AdminStorage() {
  const [rows, setRows] = useState<Stat[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Stat | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error: e } = await supabase.rpc('get_storage_stats');
    if (e) setError(e.message);
    setRows((data as Stat[]) ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const totals = useMemo(() => rows.reduce(
    (acc, r) => ({
      bytes: acc.bytes + Number(r.total_bytes ?? 0),
      shots: acc.shots + Number(r.screenshot_count ?? 0),
      vids:  acc.vids  + Number(r.video_count ?? 0),
      logs:  acc.logs  + Number(r.activity_log_rows ?? 0),
    }),
    { bytes: 0, shots: 0, vids: 0, logs: 0 },
  ), [rows]);

  const filtered = rows.filter((r) =>
    !search || r.org_name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <AdminLayout title="Storage & Data Usage">
      <p className="text-xs text-gray-500 max-w-2xl mb-4">
        Per-customer storage breakdown across screenshot / video buckets and Postgres tables.
        Use the cleanup tool to delete data older than a chosen date for any single customer.
      </p>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>
      )}

      {/* SUMMARY STRIP */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Summary label="Total Storage"   value={fmtBytes(totals.bytes)} accent="text-cyan-400" icon="ri-database-2-line" />
        <Summary label="Screenshots"     value={totals.shots.toLocaleString()} accent="text-violet-400" icon="ri-image-line" />
        <Summary label="Videos"          value={totals.vids.toLocaleString()}  accent="text-amber-400" icon="ri-vidicon-line" />
        <Summary label="Activity Rows"   value={totals.logs.toLocaleString()}  accent="text-emerald-400" icon="ri-list-check-2" />
      </div>

      <div className="flex items-center gap-2 mb-3">
        <input
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer…"
          className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none w-60"
        />
        <button onClick={load} className="px-3 py-1.5 text-xs rounded-lg bg-dark-800 hover:bg-dark-700 text-gray-300">
          <i className="ri-refresh-line mr-1" /> Refresh
        </button>
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Partner</th>
              <th className="px-4 py-3 text-right">Agents</th>
              <th className="px-4 py-3 text-right">Screenshots</th>
              <th className="px-4 py-3 text-right">Videos</th>
              <th className="px-4 py-3 text-right">Activity / Metrics / Alerts</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && filtered.length === 0 && <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500 text-xs">No customers</td></tr>}
            {filtered.map((r) => (
              <tr key={r.organization_id} className="hover:bg-dark-700/30">
                <td className="px-4 py-3 text-white">{r.org_name}</td>
                <td className="px-4 py-3 text-gray-400">{r.partner_name ?? <span className="text-gray-600">— direct —</span>}</td>
                <td className="px-4 py-3 text-right text-gray-300">{r.agent_count}</td>
                <td className="px-4 py-3 text-right">
                  <span className="text-violet-300">{Number(r.screenshot_count).toLocaleString()}</span>
                  <span className="block text-[10px] text-gray-500">{fmtBytes(Number(r.screenshot_bytes))}</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-amber-300">{Number(r.video_count).toLocaleString()}</span>
                  <span className="block text-[10px] text-gray-500">{fmtBytes(Number(r.video_bytes))}</span>
                </td>
                <td className="px-4 py-3 text-right text-[11px] text-gray-400">
                  {Number(r.activity_log_rows).toLocaleString()} / {Number(r.metric_rows).toLocaleString()} / {Number(r.alert_rows).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right text-cyan-300 font-medium">{fmtBytes(Number(r.total_bytes))}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setTarget(r)}
                    className="px-2.5 py-1 text-[11px] rounded-md bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                  >
                    Clean up…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {target && (
        <CleanupModal
          row={target}
          onClose={() => setTarget(null)}
          onDone={async () => { setTarget(null); await load(); }}
        />
      )}
    </AdminLayout>
  );
}

function Summary({ label, value, accent, icon }: { label: string; value: string; accent: string; icon: string }) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <i className={`${icon} ${accent}`} />
        <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      </div>
      <p className="text-xl font-semibold text-white">{value}</p>
    </div>
  );
}

function CleanupModal({ row, onClose, onDone }: { row: Stat; onClose: () => void; onDone: () => void }) {
  const [before, setBefore] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  });
  const [kinds, setKinds] = useState<Record<string, boolean>>({
    screenshots: true, videos: true, activity_logs: false, system_metrics: false, alerts: false,
  });
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [result, setResult] = useState<Array<{ kind: string; deleted: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedKinds = Object.entries(kinds).filter(([, v]) => v).map(([k]) => k);
  const phrase = `DELETE ${row.org_name}`;

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    const beforeIso = new Date(before + 'T00:00:00Z').toISOString();
    const { data, error: e } = await supabase.rpc('purge_org_data', {
      p_org_id: row.organization_id,
      p_before: beforeIso,
      p_kinds:  selectedKinds,
    });
    setBusy(false);
    if (e) { setError(e.message); return; }
    setResult((data as Array<{ kind: string; deleted: number }>) ?? []);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-900 border border-dark-700 rounded-2xl w-full max-w-lg p-6">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h2 className="text-base font-semibold text-white">Clean up data</h2>
            <p className="text-xs text-gray-500 mt-0.5">{row.org_name}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><i className="ri-close-line text-lg" /></button>
        </div>

        {!result ? (
          <>
            <div className="mt-4">
              <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1.5">Delete data older than</label>
              <input
                type="date"
                value={before}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setBefore(e.target.value)}
                className="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-rose-500"
              />
              <p className="text-[11px] text-gray-500 mt-1.5">
                Deletes everything older than 00:00 UTC on this day. Pick a date that is at least a few days back to avoid wiping fresh data.
              </p>
            </div>

            <div className="mt-4">
              <p className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">What to delete</p>
              <div className="space-y-2">
                {KIND_META.map((k) => (
                  <label key={k.key} className="flex items-start gap-2 px-3 py-2 rounded-lg border border-dark-700 hover:border-dark-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={kinds[k.key]}
                      onChange={(e) => setKinds((s) => ({ ...s, [k.key]: e.target.checked }))}
                      className="mt-0.5 accent-rose-500"
                    />
                    <div>
                      <p className="text-sm text-white">{k.label}</p>
                      <p className="text-[11px] text-gray-500">{k.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-4 px-3 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200">
              <p className="font-medium mb-1">⚠ Permanent deletion</p>
              <p>Type <code className="px-1 bg-rose-500/20 rounded">{phrase}</code> below to confirm.</p>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={phrase}
                className="mt-2 w-full bg-dark-900 border border-rose-500/30 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-rose-500"
              />
            </div>

            {error && <p className="text-[11px] text-rose-300 mt-3">{error}</p>}

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={onClose} className="px-3 py-2 text-xs rounded-lg bg-dark-800 text-gray-300 hover:bg-dark-700">Cancel</button>
              <button
                onClick={run}
                disabled={busy || confirmText !== phrase || selectedKinds.length === 0}
                className="px-4 py-2 text-xs rounded-lg bg-rose-500 text-white hover:bg-rose-400 disabled:opacity-40 font-medium"
              >
                {busy ? 'Deleting…' : `Delete ${selectedKinds.length} kind(s)`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mt-3 px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
              ✓ Cleanup complete
            </div>
            <ul className="mt-4 space-y-1.5">
              {result.map((r) => (
                <li key={r.kind} className="flex justify-between text-xs">
                  <span className="text-gray-400 capitalize">{r.kind.replace('_', ' ')}</span>
                  <span className="text-white font-medium">{Number(r.deleted).toLocaleString()} deleted</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end mt-5">
              <button onClick={onDone} className="px-4 py-2 text-xs rounded-lg bg-cyan-500 text-dark-950 hover:bg-cyan-400 font-medium">Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
