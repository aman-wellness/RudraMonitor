import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgents } from '@/lib/dataHooks';

export default function AgentTable() {
  const navigate = useNavigate();
  const { agents, loading } = useAgents();
  const [filter, setFilter] = useState<'all' | 'online' | 'offline' | 'idle'>('all');
  const [search, setSearch] = useState('');

  const filtered = agents.filter((a) => {
    const matchesFilter = filter === 'all' || a.status === filter;
    const matchesSearch =
      search === '' ||
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.machine.toLowerCase().includes(search.toLowerCase()) ||
      a.department.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const filters: { label: string; value: 'all' | 'online' | 'offline' | 'idle' }[] = [
    { label: 'All', value: 'all' },
    { label: 'Online', value: 'online' },
    { label: 'Idle', value: 'idle' },
    { label: 'Offline', value: 'offline' },
  ];

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'online':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Online
          </span>
        );
      case 'idle':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Idle
          </span>
        );
      case 'offline':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 text-red-400 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            Offline
          </span>
        );
      default:
        return null;
    }
  };

  const getOSIcon = (os: string) => {
    if (os.includes('Windows')) return 'ri-windows-fill text-blue-400';
    if (os.includes('macOS')) return 'ri-apple-fill text-gray-300';
    return 'ri-ubuntu-fill text-orange-400';
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="p-4 md:p-5 border-b border-dark-700 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <h3 className="text-sm md:text-base font-poppins font-semibold text-white">
          Monitored Agents
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center bg-dark-900 rounded-lg p-1">
            {filters.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  filter === f.value
                    ? 'bg-dark-700 text-white'
                    : 'text-gray-500 hover:text-gray-400'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5">
            <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
              <i className="ri-search-line text-sm" />
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents..."
              className="bg-transparent text-xs text-white placeholder-gray-600 focus:outline-none w-32 md:w-40"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-dark-700">
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">
                Agent
              </th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">
                Machine
              </th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">
                OS
              </th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">
                Status
              </th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">
                Productivity
              </th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">
                Active Hours
              </th>
              <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">
                Current Apps
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((agent) => (
              <tr
                key={agent.id}
                onClick={() => navigate(`/agents/${agent.id}`)}
                className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors cursor-pointer"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-dark-700 flex items-center justify-center">
                      <span className="text-xs text-gray-400 font-medium">
                        {agent.name.charAt(0)}
                      </span>
                    </div>
                    <div>
                      <p className="text-sm text-white font-medium">{agent.name}</p>
                      <p className="text-xs text-gray-500">{agent.department}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <p className="text-sm text-gray-300">{agent.machine}</p>
                  <p className="text-xs text-gray-500">{agent.ipAddress}</p>
                </td>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2 text-sm text-gray-300">
                    <span className="w-4 h-4 flex items-center justify-center">
                      <i className={`${getOSIcon(agent.os)} text-base`} />
                    </span>
                    {agent.os}
                  </span>
                </td>
                <td className="px-4 py-3">{getStatusBadge(agent.status)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-2 bg-dark-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          agent.productivity >= 80
                            ? 'bg-emerald-500'
                            : agent.productivity >= 60
                              ? 'bg-amber-500'
                              : 'bg-red-500'
                        }`}
                        style={{ width: `${agent.productivity}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-400">{agent.productivity}%</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <p className="text-sm text-gray-300">{agent.activeHours}</p>
                  <p className="text-xs text-gray-500">Idle: {agent.idleTime}</p>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {agent.status === 'offline' ? (
                      <span className="text-xs text-gray-600">-</span>
                    ) : (
                      agent.applications.slice(0, 2).map((app) => (
                        <span
                          key={app}
                          className="px-2 py-0.5 bg-dark-700 rounded text-xs text-gray-400"
                        >
                          {app}
                        </span>
                      ))
                    )}
                    {agent.applications.length > 2 && (
                      <span className="px-2 py-0.5 bg-dark-700 rounded text-xs text-gray-500">
                        +{agent.applications.length - 2}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && agents.length === 0 && (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-gray-400 mb-1">No agents enrolled yet</p>
            <p className="text-xs text-gray-600 mb-4">
              Install the desktop agent on employee machines using your license key.
            </p>
            <button
              onClick={() => navigate('/setup')}
              className="px-4 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors inline-flex items-center gap-2"
            >
              <i className="ri-add-line text-sm" />
              Go to Agent Setup
            </button>
          </div>
        )}
        {loading && agents.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-gray-500">Loading agents…</div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-dark-700 flex items-center justify-between">
        <span className="text-xs text-gray-500">
          Showing {filtered.length} of {agents.length} agents
        </span>
        <button
          onClick={() => navigate('/agents')}
          className="px-3 py-1.5 text-xs text-emerald-400 hover:text-emerald-300 font-medium flex items-center gap-1 transition-colors"
        >
          View All Agents
          <span className="w-3 h-3 flex items-center justify-center">
            <i className="ri-arrow-right-line text-xs" />
          </span>
        </button>
      </div>
    </div>
  );
}