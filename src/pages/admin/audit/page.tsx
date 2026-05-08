import { useEffect, useState } from 'react';
import AdminLayout from '../AdminLayout';
import { supabase, type AuditLogEntry } from '@/lib/supabase';

export default function AdminAudit() {
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('audit_log').select('*')
        .order('created_at', { ascending: false }).limit(500);
      setRows((data as AuditLogEntry[]) ?? []);
      setLoading(false);
    })();
  }, []);

  const filtered = rows.filter((r) =>
    !search || r.action.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <AdminLayout title="Audit Log">
      <div className="mb-4">
        <input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by action (e.g. partner.approve, license.revoke)..."
          className="w-full sm:w-96 bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none"
        />
      </div>
      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-dark-900/50 text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">When</th>
              <th className="px-4 py-3 text-left">Actor</th>
              <th className="px-4 py-3 text-left">Action</th>
              <th className="px-4 py-3 text-left">Target</th>
              <th className="px-4 py-3 text-left">Metadata</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {loading && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500 text-xs">Loading…</td></tr>}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500 text-xs">No entries</td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-dark-700/30">
                <td className="px-4 py-3 text-gray-500 text-[11px] whitespace-nowrap">
                  {new Date(r.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="px-4 py-3 text-gray-400 text-[11px]">{r.actor_role ?? '—'}</td>
                <td className="px-4 py-3 font-mono text-xs text-cyan-400">{r.action}</td>
                <td className="px-4 py-3 text-gray-500 text-[11px]">
                  {r.target_type && <span>{r.target_type}: <span className="text-gray-400">{r.target_id?.slice(0, 8)}…</span></span>}
                </td>
                <td className="px-4 py-3 text-gray-500 text-[11px] max-w-md truncate">
                  {r.metadata ? JSON.stringify(r.metadata) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminLayout>
  );
}
