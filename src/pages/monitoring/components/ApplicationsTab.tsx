import { useMemo, useState } from 'react';
import { useActivityLogs, useAgents, useProductivityRules, classify } from '@/lib/dataHooks';
import CategoryBadge from '@/components/feature/CategoryBadge';

type CategoryFilter = 'all' | 'productive' | 'unproductive' | 'neutral';

export default function ApplicationsTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [catFilter, setCatFilter] = useState<CategoryFilter>('all');
  const [search, setSearch] = useState('');

  const [limit, setLimit] = useState(200);
  const { rows, loading } = useActivityLogs({ type: 'app', agentId: agentFilter, sinceHours: 24, limit });
  const hasMore = rows.length >= limit;
  const { ruleMap, upsertRule } = useProductivityRules();

  const aggregated = useMemo(() => {
    const map = new Map<string, {
      key: string;
      appName: string;
      windowTitle: string;
      agentId: string;
      agentName: string;
      duration: number;
      lastActive: string;
      category: 'productive' | 'unproductive' | 'neutral';
    }>();
    for (const r of rows) {
      if (!r.application_name) continue;
      const key = `${r.agent_id}::${r.application_name}`;
      const existing = map.get(key);
      const dur = r.duration ?? 0;
      if (existing) {
        existing.duration += dur;
        if (r.created_at > existing.lastActive) {
          existing.lastActive = r.created_at;
          existing.windowTitle = r.url ?? existing.windowTitle;
        }
      } else {
        map.set(key, {
          key,
          appName: r.application_name,
          windowTitle: r.url ?? '',
          agentId: r.agent_id,
          agentName: r.agent_name,
          duration: dur,
          lastActive: r.created_at,
          category: classify(ruleMap, 'app', r.application_name),
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.duration - a.duration);
  }, [rows, ruleMap]);

  const filtered = aggregated.filter((log) => {
    const matchCat = catFilter === 'all' || log.category === catFilter;
    const matchSearch =
      search === '' ||
      log.appName.toLowerCase().includes(search.toLowerCase()) ||
      log.windowTitle.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const catOptions: { value: CategoryFilter; label: string; color: string }[] = [
    { value: 'all', label: 'All', color: 'bg-dark-700 text-white' },
    { value: 'productive', label: 'Productive', color: 'bg-emerald-500/15 text-emerald-400' },
    { value: 'unproductive', label: 'Unproductive', color: 'bg-red-500/15 text-red-400' },
    { value: 'neutral', label: 'Neutral', color: 'bg-gray-500/15 text-gray-400' },
  ];

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  };
  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {catOptions.map((c) => (
            <button
              key={c.value}
              onClick={() => setCatFilter(c.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                catFilter === c.value ? c.color : 'text-gray-500 hover:text-gray-400 bg-dark-800'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
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
          <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5">
            <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
              <i className="ri-search-line text-sm" />
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search apps..."
              className="bg-transparent text-xs text-white placeholder-gray-600 focus:outline-none w-32 md:w-40"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filtered.map((log) => {
          const catColor =
            log.category === 'productive'
              ? 'border-emerald-500/20 bg-emerald-500/5'
              : log.category === 'unproductive'
                ? 'border-red-500/20 bg-red-500/5'
                : 'border-gray-500/20 bg-gray-500/5';
          return (
            <div key={log.key} className={`rounded-xl border ${catColor} p-4 transition-all`}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <span className="w-8 h-8 flex items-center justify-center rounded-lg bg-dark-700">
                    <i className="ri-apps-line text-lg text-gray-400" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white">{log.appName}</p>
                    <p className="text-[11px] text-gray-500">{log.agentName || 'Unknown'}</p>
                  </div>
                </div>
                <CategoryBadge value={log.category} onChange={(c) => upsertRule('app', log.appName, c)} />
              </div>
              <p className="text-xs text-gray-400 mb-3 truncate" title={log.windowTitle}>
                {log.windowTitle || '—'}
              </p>
              <div className="flex items-center justify-between text-[11px] text-gray-500">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 flex items-center justify-center"><i className="ri-time-line" /></span>
                  {formatDuration(log.duration)}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 flex items-center justify-center"><i className="ri-history-line" /></span>
                  Last: {formatTime(log.lastActive)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => setLimit((l) => l + 200)}
            className="px-4 py-1.5 rounded-lg bg-dark-800 border border-dark-700 text-gray-400 text-xs font-medium hover:bg-dark-700 transition-colors"
          >
            Load more
          </button>
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-12">
          <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
            <i className="ri-apps-line text-3xl" />
          </span>
          <p className="text-sm text-gray-500">
            {rows.length === 0 ? 'No application activity yet — agents will populate this in real time.' : 'No applications match your filters'}
          </p>
        </div>
      )}
      {loading && filtered.length === 0 && (
        <div className="text-center py-12 text-xs text-gray-500">Loading…</div>
      )}
    </div>
  );
}
