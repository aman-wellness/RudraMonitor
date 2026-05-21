import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAgents, useProductivityPerAgent } from '@/lib/dataHooks';
import { supabase } from '@/lib/supabase';

// Format helpers for the merged stats. Match the agent-detail page's
// "Xh Ym" / "Xm" conventions so users see consistent numbers when they
// drill in from a card.
const formatActive = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `0h ${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h}h ${r}m`;
};
const formatIdle = (seconds: number) => `${Math.round(seconds / 60)}m`;

const departments = ['All', 'Development', 'HR', 'Finance', 'Design', 'Sales', 'Support', 'Marketing', 'Unassigned'];
const deptOptions = departments.filter((d) => d !== 'All');
const statuses = ['All', 'online', 'idle', 'offline'];

export default function AgentsPage() {
  const navigate = useNavigate();
  const { agents: rawAgents, loading, updateDepartment, deleteAgent, refresh: refreshAgents } = useAgents();
  // Per-agent productivity / active / idle stats over the last 24 hours.
  // useAgents itself hard-codes these to zero on the UI shape because it doesn't
  // join activity_logs; without this lookup the All Agents page shows every
  // card at 0% / 0h 0m / 0m even when the agent has been reporting all day.
  const { byAgent: productivityByAgent } = useProductivityPerAgent(24);
  const agents = useMemo(
    () => rawAgents.map((a) => {
      const p = productivityByAgent[a.id];
      if (!p) return a;
      return {
        ...a,
        productivity: p.productivity_pct ?? 0,
        activeHours: formatActive(p.active_seconds ?? 0),
        idleTime: formatIdle(p.idle_seconds ?? 0),
      };
    }),
    [rawAgents, productivityByAgent],
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const handleDelete = async (e: React.MouseEvent, agentId: string, agentName: string) => {
    e.stopPropagation();
    if (!confirm(`Remove agent "${agentName}"? This frees the license but keeps historical data.`)) return;
    setRemoving(agentId);
    try {
      await deleteAgent(agentId);
    } catch (err) {
      alert(`Failed to remove agent: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRemoving(null);
    }
  };

  const handleBulkCapture = async (column: 'screenshots_enabled' | 'videos_enabled', value: boolean) => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    setBulkActionOpen(false);
    try {
      const { error } = await supabase
        .from('agents')
        .update({ [column]: value })
        .in('id', Array.from(selected));
      if (error) throw error;
      await refreshAgents();
    } catch (err) {
      alert(`Bulk update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkRemove = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Remove ${selected.size} agent${selected.size === 1 ? '' : 's'}? This frees ${selected.size} license${selected.size === 1 ? '' : 's'} but keeps historical data.`)) return;
    setBulkBusy(true);
    setBulkActionOpen(false);
    try {
      const { error } = await supabase.from('agents').delete().in('id', Array.from(selected));
      if (error) throw error;
      setSelected(new Set());
      await refreshAgents();
    } catch (err) {
      alert(`Bulk remove failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBulkBusy(false);
    }
  };
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkActionOpen, setBulkActionOpen] = useState(false);
  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return agents.filter((a) => {
      const matchesSearch =
        search === '' ||
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.machine.toLowerCase().includes(search.toLowerCase()) ||
        a.department.toLowerCase().includes(search.toLowerCase());
      const matchesDept = deptFilter === 'All' || a.department === deptFilter;
      const matchesStatus = statusFilter === 'All' || a.status === statusFilter;
      return matchesSearch && matchesDept && matchesStatus;
    });
  }, [agents, search, deptFilter, statusFilter]);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((a) => a.id)));
    }
  };

  const handleDeptChange = async (agentId: string, newDept: string) => {
    setEditingDeptId(null);
    await updateDepartment(agentId, newDept);
  };

  const DeptDropdown = ({ agentId, currentDept }: { agentId: string; currentDept: string }) => (
    <div className="relative z-30">
      <div className="absolute top-0 left-0 bg-dark-800 border border-dark-700 rounded-lg shadow-xl py-1 min-w-[140px] overflow-hidden">
        {deptOptions.map((d) => (
          <button
            key={d}
            onClick={(e) => { e.stopPropagation(); handleDeptChange(agentId, d); }}
            className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
              d === currentDept ? 'text-emerald-400 bg-emerald-500/10' : 'text-gray-300 hover:bg-dark-700'
            }`}
          >
            {d === currentDept && (
              <span className="w-3 h-3 flex items-center justify-center">
                <i className="ri-check-line text-[10px]" />
              </span>
            )}
            {d}
          </button>
        ))}
      </div>
    </div>
  );

  const getInitials = (name: string) =>
    name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

  const statusBadge = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25';
      case 'idle':
        return 'bg-amber-500/15 text-amber-400 border border-amber-500/25';
      default:
        return 'bg-red-500/15 text-red-400 border border-red-500/25';
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case 'online':
        return 'Active';
      case 'idle':
        return 'Idle';
      default:
        return 'Offline';
    }
  };

  const deptColor = (dept: string) => {
    const map: Record<string, string> = {
      Development: 'bg-blue-500/15 text-blue-400 border border-blue-500/25',
      HR: 'bg-pink-500/15 text-pink-400 border border-pink-500/25',
      Finance: 'bg-amber-500/15 text-amber-400 border border-amber-500/25',
      Design: 'bg-violet-500/15 text-violet-400 border border-violet-500/25',
      Sales: 'bg-teal-500/15 text-teal-400 border border-teal-500/25',
      Support: 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25',
      Marketing: 'bg-orange-500/15 text-orange-400 border border-orange-500/25',
    };
    return map[dept] || 'bg-gray-500/15 text-gray-400 border border-gray-500/25';
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
          <span className="text-white font-medium">Agents</span>
        </div>

        {/* Page Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-poppins font-bold text-white mb-1">All Agents</h1>
            <p className="text-sm text-gray-500">
              {filtered.length} of {agents.length} agents connected
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* View Toggle */}
            <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg p-0.5">
              <button
                onClick={() => setViewMode('grid')}
                className={`px-2.5 py-1.5 rounded-md text-xs transition-all ${
                  viewMode === 'grid' ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <span className="w-4 h-4 flex items-center justify-center"><i className="ri-grid-fill text-sm" /></span>
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`px-2.5 py-1.5 rounded-md text-xs transition-all ${
                  viewMode === 'list' ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <span className="w-4 h-4 flex items-center justify-center"><i className="ri-list-check text-sm" /></span>
              </button>
            </div>
            <button
              onClick={() => navigate('/setup')}
              className="px-4 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors flex items-center gap-2"
            >
              <span className="w-4 h-4 flex items-center justify-center"><i className="ri-add-line text-sm" /></span>
              Add Agent
            </button>
          </div>
        </div>

        {/* Bulk Actions Bar */}
        {selected.size > 0 && (
          <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2.5">
            <span className="text-xs text-emerald-400 font-medium">{selected.size} agents selected</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setBulkActionOpen(!bulkActionOpen)}
                className="px-3 py-1.5 rounded-lg bg-dark-700 text-gray-300 text-xs font-medium border border-dark-600 hover:bg-dark-600 transition-colors flex items-center gap-1.5"
              >
                Actions
                <span className="w-3 h-3 flex items-center justify-center"><i className="ri-arrow-down-s-line text-xs" /></span>
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="px-3 py-1.5 rounded-lg text-gray-500 text-xs hover:text-white transition-colors"
              >
                Clear
              </button>
              {bulkActionOpen && (
                <div className="absolute mt-24 right-6 md:right-auto bg-dark-800 border border-dark-700 rounded-lg shadow-xl z-40 overflow-hidden min-w-[180px]">
                  <button
                    onClick={() => handleBulkCapture('screenshots_enabled', true)}
                    disabled={bulkBusy}
                    className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-dark-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                  >
                    <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-image-line text-xs" /></span>
                    Enable Screenshots
                  </button>
                  <button
                    onClick={() => handleBulkCapture('screenshots_enabled', false)}
                    disabled={bulkBusy}
                    className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-dark-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                  >
                    <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-eye-off-line text-xs" /></span>
                    Disable Screenshots
                  </button>
                  <button
                    onClick={() => handleBulkCapture('videos_enabled', true)}
                    disabled={bulkBusy}
                    className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-dark-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                  >
                    <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-video-line text-xs" /></span>
                    Enable Videos
                  </button>
                  <button
                    onClick={() => handleBulkCapture('videos_enabled', false)}
                    disabled={bulkBusy}
                    className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-dark-700 transition-colors flex items-center gap-2 disabled:opacity-50"
                  >
                    <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-eye-off-line text-xs" /></span>
                    Disable Videos
                  </button>
                  <div className="border-t border-dark-700" />
                  <button
                    onClick={handleBulkRemove}
                    disabled={bulkBusy}
                    className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-2 disabled:opacity-50"
                  >
                    <span className="w-3.5 h-3.5 flex items-center justify-center">
                      <i className={`${bulkBusy ? 'ri-loader-4-line animate-spin' : 'ri-delete-bin-line'} text-xs`} />
                    </span>
                    Remove Selected ({selected.size})
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
          <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 w-full sm:w-auto sm:min-w-[260px]">
            <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
              <i className="ri-search-line text-sm" />
            </span>
            <input
              type="text"
              placeholder="Search by name, machine, department..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none w-full"
            />
          </div>
          <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1 overflow-x-auto">
            {departments.map((d) => (
              <button
                key={d}
                onClick={() => setDeptFilter(d)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
                  deptFilter === d ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-lg p-1">
            {statuses.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-all capitalize ${
                  statusFilter === s ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {s === 'All' ? 'All Status' : s}
              </button>
            ))}
          </div>
        </div>

        {/* LIST VIEW */}
        {viewMode === 'list' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[750px]">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 w-10">
                      <button onClick={selectAll} className="w-4 h-4 flex items-center justify-center">
                        <div className={`w-4 h-4 rounded border ${selected.size === filtered.length && filtered.length > 0 ? 'bg-emerald-500 border-emerald-500' : 'border-gray-600'} flex items-center justify-center`}>
                          {selected.size === filtered.length && filtered.length > 0 && <i className="ri-check-line text-[10px] text-white" />}
                        </div>
                      </button>
                    </th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Agent</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Machine</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">OS</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Status</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Productivity</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Active Hours</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3">Department</th>
                    <th className="text-right text-xs text-gray-500 font-medium px-4 py-3 w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((agent) => (
                    <tr
                      key={agent.id}
                      onClick={() => navigate(`/agents/${agent.id}`)}
                      className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3" onClick={(e) => { e.stopPropagation(); toggleSelect(agent.id); }}>
                        <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${selected.has(agent.id) ? 'bg-emerald-500 border-emerald-500' : 'border-gray-600 hover:border-gray-400'}`}>
                          {selected.has(agent.id) && <i className="ri-check-line text-[10px] text-white" />}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-dark-700 flex items-center justify-center">
                            <span className="text-xs text-gray-400 font-medium">{agent.name.charAt(0)}</span>
                          </div>
                          <div>
                            <p className="text-sm text-white font-medium">{agent.name}</p>
                            <p className="text-xs text-gray-500">{agent.ipAddress}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-300">{agent.machine}</td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1.5 text-xs text-gray-400">
                          <span className="w-4 h-4 flex items-center justify-center"><i className={`${getOSIcon(agent.os)} text-sm`} /></span>
                          {agent.os}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${statusBadge(agent.status)}`}>
                          {statusLabel(agent.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-2 bg-dark-700 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${agent.productivity >= 80 ? 'bg-emerald-500' : agent.productivity >= 60 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${agent.productivity}%` }} />
                          </div>
                          <span className="text-xs text-gray-400">{agent.productivity}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-gray-300">{agent.activeHours}</p>
                        <p className="text-xs text-gray-500">Idle: {agent.idleTime}</p>
                      </td>
                      <td className="px-4 py-3 relative">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingDeptId(editingDeptId === agent.id ? null : agent.id); }}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium ${deptColor(agent.department)} flex items-center gap-1 cursor-pointer hover:opacity-80`}
                        >
                          {agent.department}
                          <span className="w-3 h-3 flex items-center justify-center"><i className="ri-arrow-down-s-line" /></span>
                        </button>
                        {editingDeptId === agent.id && <DeptDropdown agentId={agent.id} currentDept={agent.department} />}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={(e) => handleDelete(e, agent.id, agent.name)}
                          disabled={removing === agent.id}
                          title="Remove agent (frees license)"
                          className="w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                        >
                          <i className={`${removing === agent.id ? 'ri-loader-4-line animate-spin' : 'ri-delete-bin-line'} text-sm`} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* GRID VIEW */}
        {viewMode === 'grid' && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
            {filtered.map((agent) => (
              <div
                key={agent.id}
                className={`group bg-dark-800 border rounded-xl p-5 cursor-pointer transition-all duration-300 hover:border-dark-600 hover:scale-[1.01] relative ${
                  selected.has(agent.id) ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-dark-700'
                }`}
              >
                {/* Checkbox - absolute top-left */}
                <button
                  onClick={(e) => { e.stopPropagation(); toggleSelect(agent.id); }}
                  className="absolute top-3 left-3 w-5 h-5 flex items-center justify-center z-10"
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${selected.has(agent.id) ? 'bg-emerald-500 border-emerald-500' : 'border-gray-600 hover:border-gray-400'}`}>
                    {selected.has(agent.id) && <i className="ri-check-line text-[10px] text-white" />}
                  </div>
                </button>

                {/* Remove button - bottom-right, hover-reveal so it doesn't fight the status badge */}
                <button
                  onClick={(e) => handleDelete(e, agent.id, agent.name)}
                  disabled={removing === agent.id}
                  title="Remove agent (frees license)"
                  className="absolute bottom-3 right-3 w-7 h-7 flex items-center justify-center rounded-md bg-dark-900/80 border border-dark-700 text-gray-500 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10 transition-all z-10 opacity-0 group-hover:opacity-100 disabled:opacity-50"
                >
                  <i className={`${removing === agent.id ? 'ri-loader-4-line animate-spin' : 'ri-delete-bin-line'} text-sm`} />
                </button>

                <div onClick={() => navigate(`/agents/${agent.id}`)} className="pl-7">
                  {/* Top row: Avatar + Name + Status */}
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-xl bg-violet-500/15 flex items-center justify-center flex-shrink-0">
                        <span className="text-sm font-bold text-violet-400">{getInitials(agent.name)}</span>
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-white truncate">{agent.name}</h3>
                        <p className="text-[11px] text-gray-500">{agent.machine}</p>
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 mt-1 ${statusBadge(agent.status)}`}>
                      {statusLabel(agent.status)}
                    </span>
                  </div>

                  {/* Department + OS */}
                  <div className="flex items-center gap-2 mb-4 flex-wrap relative">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditingDeptId(editingDeptId === agent.id ? null : agent.id); }}
                      className={`px-2 py-0.5 rounded-md text-[10px] font-medium ${deptColor(agent.department)} flex items-center gap-1 cursor-pointer hover:opacity-80`}
                    >
                      {agent.department}
                      <span className="w-3 h-3 flex items-center justify-center"><i className="ri-arrow-down-s-line" /></span>
                    </button>
                    {editingDeptId === agent.id && <DeptDropdown agentId={agent.id} currentDept={agent.department} />}
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-dark-900 text-gray-400 border border-dark-700">
                      {agent.os}
                    </span>
                  </div>

                  {/* Stats row */}
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="bg-dark-900 rounded-lg border border-dark-700 p-2.5 text-center">
                      <p className="text-xs font-bold text-white">{agent.productivity}%</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">Productivity</p>
                    </div>
                    <div className="bg-dark-900 rounded-lg border border-dark-700 p-2.5 text-center">
                      <p className="text-xs font-bold text-white">{agent.activeHours}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">Active</p>
                    </div>
                    <div className="bg-dark-900 rounded-lg border border-dark-700 p-2.5 text-center">
                      <p className="text-xs font-bold text-white">{agent.idleTime}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">Idle</p>
                    </div>
                  </div>

                  {/* Footer info */}
                  <div className="flex items-center justify-between pt-3 border-t border-dark-700">
                    <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                      <span className="w-3 h-3 flex items-center justify-center"><i className="ri-wifi-line" /></span>
                      {agent.ipAddress}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                      <span className="w-3 h-3 flex items-center justify-center"><i className="ri-time-line" /></span>
                      {agent.lastActive && agent.lastActive !== '-'
                        ? new Date(agent.lastActive).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-12 text-center">
            <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
              <i className="ri-search-2-line text-3xl" />
            </span>
            <p className="text-sm text-gray-500 mb-1">
              {agents.length === 0 ? 'No agents enrolled yet' : 'No agents match your filters'}
            </p>
            {agents.length === 0 && (
              <button
                onClick={() => navigate('/setup')}
                className="mt-3 px-4 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors inline-flex items-center gap-2"
              >
                <i className="ri-add-line text-sm" />
                Add your first agent
              </button>
            )}
          </div>
        )}
        {loading && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-8 text-center text-xs text-gray-500">
            Loading agents…
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}