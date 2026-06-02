import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

/**
 * /addon-seats
 *
 * Customer-portal page where org owners/admins assign add-on seats to
 * specific agents. The org buys N DLP seats (or EM seats) — they pick
 * exactly which N agents consume those seats here.
 *
 * The trigger `enforce_addon_seat_cap` rejects INSERTs that exceed the
 * cap, so the UI just shows a friendly "no seats left" message if the
 * server rejects.
 */

type ActiveAddon = {
  org_addon_id: string;
  plan_id: string;
  addon_code: string;
  addon_name: string;
  seat_count: number;
  assigned_count: number;
};

type Agent = {
  id: string;
  agent_name: string;
  machine_name: string | null;
  department: string | null;
  status: string | null;
};

type Assignment = {
  agent_id: string;
  addon_plan_id: string;
};

export default function AddonSeatsPage() {
  const { organization } = useAuth();
  const [addons, setAddons] = useState<ActiveAddon[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedAddonId, setSelectedAddonId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = async () => {
    if (!organization?.id) return;
    setLoading(true); setError(null);
    try {
      const [addonsRes, agentsRes, assignsRes] = await Promise.all([
        supabase
          .from('org_addons')
          .select('id, plan_id, seat_count, plans!inner(code, name)')
          .eq('org_id', organization.id)
          .eq('active', true),
        supabase
          .from('agents')
          .select('id, agent_name, machine_name, department, status')
          .eq('org_id', organization.id)
          .order('agent_name'),
        supabase
          .from('org_addon_assignments')
          .select('agent_id, addon_plan_id')
          .eq('org_id', organization.id),
      ]);
      if (addonsRes.error) throw new Error(addonsRes.error.message);
      if (agentsRes.error) throw new Error(agentsRes.error.message);
      if (assignsRes.error) throw new Error(assignsRes.error.message);

      type Joined = {
        id: string; plan_id: string; seat_count: number;
        plans: { code: string; name: string } | { code: string; name: string }[];
      };
      const assignsList: Assignment[] = (assignsRes.data ?? []) as Assignment[];
      const addonRows: ActiveAddon[] = (addonsRes.data as Joined[] ?? []).map((r) => {
        const p = Array.isArray(r.plans) ? r.plans[0] : r.plans;
        const used = assignsList.filter((a) => a.addon_plan_id === r.plan_id).length;
        return {
          org_addon_id: r.id, plan_id: r.plan_id,
          addon_code: p.code, addon_name: p.name,
          seat_count: r.seat_count, assigned_count: used,
        };
      });
      setAddons(addonRows);
      setAgents((agentsRes.data ?? []) as Agent[]);
      setAssignments(assignsList);
      if (!selectedAddonId && addonRows.length > 0) setSelectedAddonId(addonRows[0].plan_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [organization?.id]);

  const selected = addons.find((a) => a.plan_id === selectedAddonId);
  const assignedSet = new Set(assignments.filter((a) => a.addon_plan_id === selectedAddonId).map((a) => a.agent_id));
  const filteredAgents = agents.filter((a) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return a.agent_name.toLowerCase().includes(q) ||
           (a.machine_name ?? '').toLowerCase().includes(q) ||
           (a.department ?? '').toLowerCase().includes(q);
  });

  const toggleAgent = async (agentId: string) => {
    if (!organization?.id || !selected) return;
    setBusyAgentId(agentId); setError(null);
    try {
      if (assignedSet.has(agentId)) {
        const { error } = await supabase
          .from('org_addon_assignments')
          .delete()
          .eq('org_id', organization.id)
          .eq('agent_id', agentId)
          .eq('addon_plan_id', selected.plan_id);
        if (error) throw new Error(error.message);
      } else {
        if (selected.assigned_count >= selected.seat_count) {
          throw new Error(`No ${selected.addon_name} seats left. Buy more seats or remove an existing assignment.`);
        }
        const { error } = await supabase
          .from('org_addon_assignments')
          .insert({ org_id: organization.id, agent_id: agentId, addon_plan_id: selected.plan_id });
        if (error) throw new Error(error.message);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-white">Add-on seats</h1>
            <p className="text-xs text-gray-500 mt-1">
              Assign specific agents to each add-on. Only assigned agents consume seats.
            </p>
          </div>
          <Link to="/subscription" className="text-xs text-emerald-400 hover:text-emerald-300">← Back to subscription</Link>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>
        )}

        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : addons.length === 0 ? (
          <div className="bg-dark-800 border border-dark-700 rounded-2xl p-8 text-center">
            <p className="text-sm text-gray-400">No active add-ons yet.</p>
            <Link to="/subscription" className="inline-block mt-3 text-xs text-emerald-400 hover:text-emerald-300">
              Browse add-ons →
            </Link>
          </div>
        ) : (
          <>
            {/* Active add-ons summary cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
              {addons.map((a) => {
                const isSel = a.plan_id === selectedAddonId;
                const full = a.assigned_count >= a.seat_count;
                return (
                  <button key={a.org_addon_id} onClick={() => setSelectedAddonId(a.plan_id)}
                          className={`text-left p-4 rounded-xl border transition-colors ${
                            isSel ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-dark-800 border-dark-700 hover:border-dark-600'
                          }`}>
                    <p className="text-sm font-medium text-white">{a.addon_name}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">{a.addon_code}</p>
                    <p className="mt-3 text-xs">
                      <span className={`font-semibold ${full ? 'text-amber-300' : 'text-emerald-300'}`}>
                        {a.assigned_count} / {a.seat_count}
                      </span>
                      <span className="text-gray-500"> seats assigned</span>
                    </p>
                  </button>
                );
              })}
            </div>

            {/* Selected add-on: agent assignment list */}
            {selected && (
              <div className="bg-dark-800 border border-dark-700 rounded-2xl">
                <div className="p-4 border-b border-dark-700 flex flex-wrap items-center gap-3">
                  <h2 className="text-sm font-semibold text-white">Assign {selected.addon_name}</h2>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
                    selected.assigned_count >= selected.seat_count
                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                      : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                  }`}>
                    {selected.assigned_count} / {selected.seat_count} seats
                  </span>
                  <div className="ml-auto">
                    <input value={filter} onChange={(e) => setFilter(e.target.value)}
                           placeholder="Filter agents…"
                           className="bg-dark-900 border border-dark-700 rounded-md px-2.5 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 w-44" />
                  </div>
                </div>
                <ul className="divide-y divide-dark-700">
                  {filteredAgents.length === 0 ? (
                    <li className="px-4 py-6 text-center text-xs text-gray-500">No agents enrolled yet.</li>
                  ) : filteredAgents.map((agent) => {
                    const isAssigned = assignedSet.has(agent.id);
                    const wouldExceed = !isAssigned && selected.assigned_count >= selected.seat_count;
                    return (
                      <li key={agent.id} className="px-4 py-2.5 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate">{agent.agent_name}</p>
                          <p className="text-[11px] text-gray-500 truncate">
                            {agent.machine_name ?? '—'}{agent.department ? ` · ${agent.department}` : ''}
                            {agent.status && <span className={`ml-2 ${
                              agent.status === 'online' ? 'text-emerald-400'
                              : agent.status === 'idle' ? 'text-amber-400'
                              : 'text-gray-500'
                            }`}>• {agent.status}</span>}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleAgent(agent.id)}
                          disabled={busyAgentId === agent.id || wouldExceed}
                          className={`shrink-0 w-11 h-6 rounded-full relative transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                            isAssigned ? 'bg-emerald-500' : 'bg-dark-700'
                          }`}
                          title={wouldExceed ? 'Seat cap reached — buy more seats or unassign another agent first' : undefined}
                          aria-pressed={isAssigned}
                        >
                          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${isAssigned ? 'left-5' : 'left-0.5'}`} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
