import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAgents, useLatestSystemMetrics } from '@/lib/dataHooks';

// Adapter shape preserved so the existing JSX below stays unchanged.
// Network/temp/uptime/processes aren't yet collected by the agent — placeholders for now.
type LegacyMetrics = { cpu: number; memory: number; disk: number; uptime: string; network: number; temp: number; processes: number };

const services = [
  { name: 'Agent Service', status: 'running', uptime: '99.9%', icon: 'ri-shield-check-line' },
  { name: 'Screenshot Engine', status: 'running', uptime: '99.8%', icon: 'ri-image-line' },
  { name: 'Alert Monitor', status: 'running', uptime: '99.9%', icon: 'ri-notification-3-line' },
  { name: 'Sync Service', status: 'running', uptime: '99.6%', icon: 'ri-refresh-line' },
];

const healthTabs = ['Overview', 'Agents', 'Services', 'Network'] as const;
type HealthTab = (typeof healthTabs)[number];

export default function SystemHealthPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<HealthTab>('Overview');
  const [search, setSearch] = useState('');
  const { agents } = useAgents();
  const { byAgent } = useLatestSystemMetrics();

  const systemMetrics: Record<string, LegacyMetrics> = useMemo(() => {
    const out: Record<string, LegacyMetrics> = {};
    for (const a of agents) {
      const m = byAgent[a.id];
      out[a.id] = {
        cpu: m?.cpu_usage ?? 0,
        memory: m?.ram_usage ?? 0,
        disk: m?.disk_usage ?? 0,
        uptime: m ? '—' : 'Offline',
        network: 0,
        temp: 0,
        processes: 0,
      };
    }
    return out;
  }, [agents, byAgent]);

  const filteredAgents = agents.filter((a) =>
    search === '' || a.name.toLowerCase().includes(search.toLowerCase()) || a.machine.toLowerCase().includes(search.toLowerCase())
  );

  const onlineAgents = agents.filter((a) => a.status !== 'offline');
  const criticalAgents = agents.filter((a) => {
    const m = systemMetrics[a.id];
    return m && (m.cpu > 70 || m.memory > 75 || m.disk > 80);
  });

  const safeAvg = (vals: number[]) => (vals.length === 0 ? 0 : Math.round(vals.reduce((a, b) => a + b, 0) / vals.length));
  const avgCpu = safeAvg(onlineAgents.map((a) => systemMetrics[a.id]?.cpu || 0));
  const avgMemory = safeAvg(onlineAgents.map((a) => systemMetrics[a.id]?.memory || 0));
  const avgDisk = safeAvg(onlineAgents.map((a) => systemMetrics[a.id]?.disk || 0));

  const getBarColor = (val: number) => {
    if (val > 75) return 'bg-red-500';
    if (val > 50) return 'bg-amber-500';
    return 'bg-emerald-500';
  };

  const getHealthStatus = (m: LegacyMetrics | undefined) => {
    if (!m || m.cpu === 0) return { label: 'Offline', class: 'bg-gray-500/15 text-gray-400' };
    const avg = (m.cpu + m.memory + m.disk) / 3;
    if (avg > 70 || m.cpu > 80 || m.temp > 70) return { label: 'Critical', class: 'bg-red-500/15 text-red-400' };
    if (avg > 50 || m.cpu > 60) return { label: 'Warning', class: 'bg-amber-500/15 text-amber-400' };
    return { label: 'Healthy', class: 'bg-emerald-500/15 text-emerald-400' };
  };

  const getOSIcon = (os: string) => {
    if (os.includes('Windows')) return 'ri-windows-fill text-blue-400';
    if (os.includes('macOS')) return 'ri-apple-fill text-gray-300';
    return 'ri-ubuntu-fill text-orange-400';
  };

  return (
    <DashboardLayout>
      <div className="space-y-5">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-dashboard-line" /></span>
            Dashboard
          </span>
          <i className="ri-arrow-right-s-line text-gray-600" />
          <span className="text-white font-medium">System Health</span>
        </div>

        {/* Header */}
        <div>
          <h1 className="text-xl font-poppins font-bold text-white mb-1">System Health</h1>
          <p className="text-sm text-gray-500">Real-time monitoring of all connected agents and services</p>
        </div>

        {/* Overview Stats */}
        {tab === 'Overview' && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            {[
              { label: 'Online Agents', value: String(onlineAgents.length), icon: 'ri-wifi-line', color: 'emerald' },
              { label: 'Critical', value: String(criticalAgents.length), icon: 'ri-error-warning-line', color: 'red' },
              { label: 'Avg CPU', value: `${avgCpu}%`, icon: 'ri-cpu-line', color: 'amber' },
              { label: 'Avg Memory', value: `${avgMemory}%`, icon: 'ri-database-2-line', color: 'teal' },
            ].map((s) => (
              <div key={s.label} className="bg-dark-800 border border-dark-700 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-8 h-8 rounded-lg bg-${s.color}-500/10 flex items-center justify-center`}>
                    <span className="w-4 h-4 flex items-center justify-center"><i className={`${s.icon} text-${s.color}-400 text-sm`} /></span>
                  </span>
                </div>
                <p className="text-xl font-poppins font-bold text-white">{s.value}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1 overflow-x-auto">
          {healthTabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-md text-xs font-medium whitespace-nowrap transition-all ${tab === t ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* OVERVIEW */}
        {tab === 'Overview' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* System Averages */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Resource Usage Overview</h3>
              <div className="space-y-4">
                {[
                  { label: 'CPU Usage', value: avgCpu, icon: 'ri-cpu-line' },
                  { label: 'Memory Usage', value: avgMemory, icon: 'ri-database-2-line' },
                  { label: 'Disk Usage', value: avgDisk, icon: 'ri-hard-drive-2-line' },
                ].map((r) => (
                  <div key={r.label}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="flex items-center gap-2 text-xs text-gray-400">
                        <span className="w-4 h-4 flex items-center justify-center"><i className={`${r.icon} text-gray-500`} /></span>
                        {r.label}
                      </span>
                      <span className={`text-xs font-medium ${r.value > 75 ? 'text-red-400' : r.value > 50 ? 'text-amber-400' : 'text-emerald-400'}`}>{r.value}%</span>
                    </div>
                    <div className="w-full bg-dark-700 rounded-full h-2.5">
                      <div className={`h-2.5 rounded-full ${getBarColor(r.value)}`} style={{ width: `${r.value}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Services Status */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Core Services</h3>
              <div className="space-y-2">
                {services.map((svc) => (
                  <div key={svc.name} className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
                    <div className="flex items-center gap-3">
                      <span className="w-8 h-8 rounded-lg bg-dark-700 flex items-center justify-center">
                        <span className="w-4 h-4 flex items-center justify-center"><i className={`${svc.icon} text-gray-400 text-sm`} /></span>
                      </span>
                      <div>
                        <p className="text-sm text-white font-medium">{svc.name}</p>
                        <p className="text-[11px] text-gray-500">Uptime: {svc.uptime}</p>
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${svc.status === 'running' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                      {svc.status === 'running' ? 'Running' : 'Maintenance'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Critical Agents */}
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 md:col-span-2">
              <h3 className="text-sm font-semibold text-white mb-4">Agents Needing Attention</h3>
              {criticalAgents.length === 0 ? (
                <div className="bg-dark-900 rounded-lg border border-dark-700 p-6 text-center">
                  <span className="w-10 h-10 flex items-center justify-center mx-auto mb-2 text-emerald-400">
                    <i className="ri-shield-check-line text-2xl" />
                  </span>
                  <p className="text-sm text-gray-400">All agents are running healthy</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {criticalAgents.map((a) => {
                    const m = systemMetrics[a.id];
                    return (
                      <div key={a.id} className="bg-dark-900 rounded-lg border border-red-500/20 p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-red-500/15 flex items-center justify-center">
                              <span className="text-xs text-red-400 font-semibold">{a.name.charAt(0)}</span>
                            </div>
                            <div>
                              <p className="text-sm text-white font-medium">{a.name}</p>
                              <p className="text-[11px] text-gray-500">{a.machine}</p>
                            </div>
                          </div>
                          <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 text-[10px] font-medium">Critical</span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {m && (
                            <>
                              <div className="text-center">
                                <p className="text-xs font-bold text-red-400">{m.cpu}%</p>
                                <p className="text-[10px] text-gray-500">CPU</p>
                              </div>
                              <div className="text-center">
                                <p className="text-xs font-bold text-amber-400">{m.memory}%</p>
                                <p className="text-[10px] text-gray-500">RAM</p>
                              </div>
                              <div className="text-center">
                                <p className="text-xs font-bold text-red-400">{m.disk}%</p>
                                <p className="text-[10px] text-gray-500">Disk</p>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* AGENTS TAB */}
        {tab === 'Agents' && (
          <div>
            <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 mb-4 w-full sm:w-auto sm:min-w-[260px]">
              <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
                <i className="ri-search-line text-sm" />
              </span>
              <input
                type="text"
                placeholder="Search agents..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none w-full"
              />
            </div>
            <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px]">
                  <thead>
                    <tr className="border-b border-dark-700">
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Agent</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">OS</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">CPU</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Memory</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Disk</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Network</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Temp</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Uptime</th>
                      <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAgents.map((a) => {
                      const m = systemMetrics[a.id];
                      const h = getHealthStatus(m);
                      return (
                        <tr key={a.id} onClick={() => navigate(`/agents/${a.id}`)} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors cursor-pointer">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                                <span className="text-xs text-violet-400 font-semibold">{a.name.charAt(0)}</span>
                              </div>
                              <div>
                                <p className="text-sm text-white font-medium">{a.name}</p>
                                <p className="text-xs text-gray-500">{a.machine}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="flex items-center gap-1.5 text-xs text-gray-400">
                              <span className="w-4 h-4 flex items-center justify-center"><i className={`${getOSIcon(a.os)} text-sm`} /></span>
                              {a.os}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-14 h-2 bg-dark-700 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${getBarColor(m?.cpu || 0)}`} style={{ width: `${m?.cpu || 0}%` }} />
                              </div>
                              <span className="text-xs text-gray-300">{m?.cpu || 0}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-14 h-2 bg-dark-700 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${getBarColor(m?.memory || 0)}`} style={{ width: `${m?.memory || 0}%` }} />
                              </div>
                              <span className="text-xs text-gray-300">{m?.memory || 0}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-14 h-2 bg-dark-700 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${getBarColor(m?.disk || 0)}`} style={{ width: `${m?.disk || 0}%` }} />
                              </div>
                              <span className="text-xs text-gray-300">{m?.disk || 0}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-300">{m?.network || 0} Mbps</td>
                          <td className="px-4 py-3 text-xs text-gray-300">{m?.temp || 0}°C</td>
                          <td className="px-4 py-3 text-xs text-gray-300">{m?.uptime || '-'}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${h.class}`}>{h.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filteredAgents.length === 0 && (
                <div className="p-12 text-center">
                  <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600"><i className="ri-search-2-line text-3xl" /></span>
                  <p className="text-sm text-gray-500">No agents found</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* SERVICES TAB */}
        {tab === 'Services' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {services.map((svc) => (
              <div key={svc.name} className="bg-dark-800 border border-dark-700 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className="w-10 h-10 rounded-lg bg-dark-700 flex items-center justify-center">
                      <span className="w-5 h-5 flex items-center justify-center"><i className={`${svc.icon} text-gray-300 text-lg`} /></span>
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-white">{svc.name}</h3>
                      <p className="text-[11px] text-gray-500">Core service</p>
                    </div>
                  </div>
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-medium ${svc.status === 'running' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                    {svc.status === 'running' ? 'Running' : 'Maintenance'}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
                  <div className="bg-dark-900 rounded-lg border border-dark-700 p-2.5 text-center">
                    <p className="text-xs font-bold text-white">{svc.uptime}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">Uptime</p>
                  </div>
                  <div className="bg-dark-900 rounded-lg border border-dark-700 p-2.5 text-center">
                    <p className="text-xs font-bold text-white">0ms</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">Latency</p>
                  </div>
                  <div className="bg-dark-900 rounded-lg border border-dark-700 p-2.5 text-center">
                    <p className="text-xs font-bold text-white">OK</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">Health</p>
                  </div>
                </div>
                <div className="w-full bg-dark-700 rounded-full h-2">
                  <div className="bg-emerald-500 h-2 rounded-full" style={{ width: svc.uptime }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* NETWORK TAB */}
        {tab === 'Network' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Network Activity</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Agent</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">IP Address</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Download</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Upload</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Latency</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => {
                    const m = systemMetrics[a.id];
                    const down = (m?.network || 0) * 2.3;
                    const up = (m?.network || 0) * 0.8;
                    return (
                      <tr key={a.id} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-violet-500/15 flex items-center justify-center">
                              <span className="text-xs text-violet-400 font-semibold">{a.name.charAt(0)}</span>
                            </div>
                            <p className="text-sm text-white font-medium">{a.name}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{a.ipAddress}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{down.toFixed(1)} Mbps</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{up.toFixed(1)} Mbps</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{(Math.random() * 40 + 10).toFixed(0)} ms</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${a.status === 'online' ? 'bg-emerald-500/15 text-emerald-400' : a.status === 'idle' ? 'bg-amber-500/15 text-amber-400' : 'bg-red-500/15 text-red-400'}`}>
                            {a.status === 'online' ? 'Connected' : a.status === 'idle' ? 'Idle' : 'Disconnected'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}