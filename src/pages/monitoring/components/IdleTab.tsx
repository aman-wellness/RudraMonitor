import { useState } from 'react';
import { useActivityLogs, useAgents } from '@/lib/dataHooks';

export default function IdleTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [search, setSearch] = useState('');

  const { rows, loading } = useActivityLogs({ type: 'idle', agentId: agentFilter, sinceHours: 24, limit: 200 });

  const filtered = rows.filter((r) => {
    if (search === '') return true;
    const start = new Date(r.created_at).toLocaleString();
    return start.toLowerCase().includes(search.toLowerCase()) || (r.agent_name ?? '').toLowerCase().includes(search.toLowerCase());
  });

  const totalIdle = filtered.reduce((acc, r) => acc + (r.duration ?? 0), 0);
  const totalHours = Math.floor(totalIdle / 3600);
  const totalMins = Math.floor((totalIdle % 3600) / 60);

  const formatStart = (iso: string) => {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };
  const formatEnd = (iso: string, durSec: number) => {
    try {
      const t = new Date(new Date(iso).getTime() + durSec * 1000);
      return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  };
  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Total Idle Events</p>
          <p className="text-2xl font-poppins font-bold text-white">{filtered.length}</p>
        </div>
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Total Idle Time</p>
          <p className="text-2xl font-poppins font-bold text-white">{totalHours}h {totalMins}m</p>
        </div>
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Threshold</p>
          <p className="text-2xl font-poppins font-bold text-amber-400">5 min</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none"
          >
            <option value="all">All Agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5">
          <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
            <i className="ri-search-line text-sm" />
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search idle periods..."
            className="bg-transparent text-xs text-white placeholder-gray-600 focus:outline-none w-32 md:w-40"
          />
        </div>
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className="border-b border-dark-700">
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">Agent</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">Start Time</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">End Time</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">Duration</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-dark-700 flex items-center justify-center">
                        <span className="text-xs text-gray-400 font-medium">{(r.agent_name || 'U').charAt(0)}</span>
                      </div>
                      <div>
                        <p className="text-sm text-white font-medium">{r.agent_name || 'Unknown'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><span className="text-sm text-gray-300">{formatStart(r.created_at)}</span></td>
                  <td className="px-4 py-3"><span className="text-sm text-gray-300">{formatEnd(r.created_at, r.duration ?? 0)}</span></td>
                  <td className="px-4 py-3"><span className="text-sm text-amber-400 font-medium">{formatDuration(r.duration ?? 0)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && filtered.length === 0 && (
        <div className="text-center py-12">
          <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
            <i className="ri-timer-line text-3xl" />
          </span>
          <p className="text-sm text-gray-500">
            {rows.length === 0 ? 'No idle periods captured — agents detect idle ≥5min automatically.' : 'No idle periods match your filters'}
          </p>
        </div>
      )}
      {loading && filtered.length === 0 && (
        <div className="text-center py-12 text-xs text-gray-500">Loading…</div>
      )}
    </div>
  );
}
