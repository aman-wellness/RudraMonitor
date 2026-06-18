import { useEffect, useState } from 'react';
import AdminLayout from '@/pages/admin/AdminLayout';
import { supabase } from '@/lib/supabase';
import { invalidateFeatureFlagsCache } from '@/lib/useGlobalFeatureFlags';

// Super-admin-only screen for global feature flags.
//
// Writes are RLS-gated to `app_users.app_role = 'super_admin'`. The
// dashboard side (Customer Admin Portal etc.) only READS this table —
// they never see this UI.
//
// On every successful toggle we invalidate the client-side hook cache
// so a customer's next navigation re-fetches the flag map and any UI
// gated on it updates without a hard refresh.

type FeatureRow = {
  code: string;
  display_name: string;
  description: string | null;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
};

export default function AdminFeatureFlagsPage() {
  const [rows, setRows] = useState<FeatureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('app_features')
      .select('*')
      .order('display_name');
    if (error) setError(error.message);
    else setRows((data ?? []) as FeatureRow[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const toggle = async (row: FeatureRow) => {
    setError(null);
    setBusy(row.code);
    const next = !row.enabled;
    // Optimistic update — flip locally first so the UI feels instant. If
    // the server rejects (e.g. RLS denied because the user isn't actually
    // a super admin) we revert on the catch path.
    setRows((prev) => prev.map((r) => (r.code === row.code ? { ...r, enabled: next } : r)));
    const { error } = await supabase
      .from('app_features')
      .update({ enabled: next })
      .eq('code', row.code);
    if (error) {
      setError(`${row.code}: ${error.message}`);
      setRows((prev) => prev.map((r) => (r.code === row.code ? { ...r, enabled: !next } : r)));
    } else {
      invalidateFeatureFlagsCache();
    }
    setBusy(null);
  };

  return (
    <AdminLayout title="Feature Flags">
      <div className="space-y-5 max-w-3xl">
        <div>
          <h1 className="text-xl font-semibold text-white">Feature Flags</h1>
          <p className="text-xs text-gray-500 mt-1">
            Global on/off switches for half-built or preview features. When a flag
            is <strong>off</strong>, the corresponding sidebar items + routes are
            hidden from every customer. Flip on when a feature is production-ready.
            Changes apply on the next page navigation customer-side.
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-xs px-4 py-2">
            {error}
          </div>
        )}

        <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">No feature flags configured.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-dark-900 border-b border-dark-700">
                <tr className="text-left text-[11px] uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-3 font-medium">Feature</th>
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 font-medium">Last updated</th>
                  <th className="px-4 py-3 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-700">
                {rows.map((r) => (
                  <tr key={r.code} className="hover:bg-dark-900/50">
                    <td className="px-4 py-3">
                      <p className="text-sm text-white font-medium">{r.display_name}</p>
                      <p className="text-[11px] text-gray-500 mt-0.5 font-mono">{r.code}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 max-w-md">{r.description ?? '—'}</td>
                    <td className="px-4 py-3 text-[11px] text-gray-500">
                      {new Date(r.updated_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => toggle(r)}
                        disabled={busy === r.code}
                        className={`relative w-12 h-6 rounded-full transition-colors disabled:opacity-50 ${
                          r.enabled ? 'bg-emerald-500' : 'bg-dark-700'
                        }`}
                        aria-label={r.enabled ? 'Disable feature' : 'Enable feature'}
                      >
                        <span
                          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                            r.enabled ? 'left-[26px]' : 'left-[2px]'
                          }`}
                        />
                      </button>
                      <p className={`text-[10px] uppercase tracking-wider mt-1 ${r.enabled ? 'text-emerald-400' : 'text-gray-600'}`}>
                        {r.enabled ? 'Live' : 'Hidden'}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="text-[11px] text-gray-600">
          To add a new feature flag, insert a row into <code className="text-gray-400">app_features</code>
          via a migration. The new row will appear here automatically.
        </p>
      </div>
    </AdminLayout>
  );
}
