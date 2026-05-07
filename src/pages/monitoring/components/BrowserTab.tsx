import { useMemo, useState } from 'react';
import { useActivityLogs, useAgents, useProductivityRules, classify } from '@/lib/dataHooks';
import CategoryBadge from '@/components/feature/CategoryBadge';

type CategoryFilter = 'all' | 'productive' | 'unproductive' | 'neutral';

// Best-effort: window titles aren't true URLs. Pull a domain-like substring if present, otherwise
// fall back to the full title so the row is still meaningful.
const extractHost = (title: string | null): string => {
  if (!title) return '—';
  const m = title.match(/(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\.[a-z]{2,})?)/i);
  return m?.[1] ?? title.slice(0, 60);
};

export default function BrowserTab() {
  const { agents } = useAgents();
  const [agentFilter, setAgentFilter] = useState('all');
  const [catFilter, setCatFilter] = useState<CategoryFilter>('all');
  const [search, setSearch] = useState('');

  const [limit, setLimit] = useState(200);
  const { rows, loading } = useActivityLogs({ type: 'browser', agentId: agentFilter, sinceHours: 24, limit });
  const hasMore = rows.length >= limit;
  const { ruleMap, upsertRule } = useProductivityRules();

  const aggregated = useMemo(() => {
    const map = new Map<string, {
      key: string;
      url: string;
      pageTitle: string;
      agentId: string;
      agentName: string;
      timeSpentSec: number;
      visits: number;
      lastVisit: string;
      category: 'productive' | 'unproductive' | 'neutral';
    }>();
    for (const r of rows) {
      const host = extractHost(r.url);
      const key = `${r.agent_id}::${host}`;
      const existing = map.get(key);
      const dur = r.duration ?? 0;
      if (existing) {
        existing.timeSpentSec += dur;
        existing.visits += 1;
        if (r.created_at > existing.lastVisit) {
          existing.lastVisit = r.created_at;
          existing.pageTitle = r.url ?? existing.pageTitle;
        }
      } else {
        map.set(key, {
          key,
          url: host,
          pageTitle: r.url ?? '',
          agentId: r.agent_id,
          agentName: r.agent_name,
          timeSpentSec: dur,
          visits: 1,
          lastVisit: r.created_at,
          category: classify(ruleMap, 'host', host),
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.timeSpentSec - a.timeSpentSec);
  }, [rows, ruleMap]);

  const filtered = aggregated.filter((log) => {
    const matchCat = catFilter === 'all' || log.category === catFilter;
    const matchSearch =
      search === '' ||
      log.url.toLowerCase().includes(search.toLowerCase()) ||
      log.pageTitle.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const catOptions: { value: CategoryFilter; label: string; color: string }[] = [
    { value: 'all', label: 'All', color: 'bg-dark-700 text-white' },
    { value: 'productive', label: 'Productive', color: 'bg-emerald-500/15 text-emerald-400' },
    { value: 'unproductive', label: 'Unproductive', color: 'bg-red-500/15 text-red-400' },
    { value: 'neutral', label: 'Neutral', color: 'bg-gray-500/15 text-gray-400' },
  ];

  const formatTime = (sec: number) => {
    const min = Math.round(sec / 60);
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const formatLast = (iso: string) => {
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
              placeholder="Search URLs..."
              className="bg-transparent text-xs text-white placeholder-gray-600 focus:outline-none w-32 md:w-40"
            />
          </div>
        </div>
      </div>

      <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead>
              <tr className="border-b border-dark-700">
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">URL</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">Page Title</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">Agent</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">Category</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">Time Spent</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">Visits</th>
                <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase tracking-wider">Last Visit</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((log) => {
                return (
                  <tr key={log.key} className="border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
                    <td className="px-4 py-3"><span className="text-sm text-emerald-400 font-medium">{log.url}</span></td>
                    <td className="px-4 py-3"><p className="text-sm text-gray-300 truncate max-w-[260px]" title={log.pageTitle}>{log.pageTitle}</p></td>
                    <td className="px-4 py-3"><p className="text-sm text-white font-medium">{log.agentName || 'Unknown'}</p></td>
                    <td className="px-4 py-3">
                      <CategoryBadge value={log.category} onChange={(c) => upsertRule('host', log.url, c)} size="md" />
                    </td>
                    <td className="px-4 py-3"><span className="text-sm text-gray-300">{formatTime(log.timeSpentSec)}</span></td>
                    <td className="px-4 py-3"><span className="text-sm text-gray-300">{log.visits}x</span></td>
                    <td className="px-4 py-3"><span className="text-sm text-gray-400">{formatLast(log.lastVisit)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
            <i className="ri-global-line text-3xl" />
          </span>
          <p className="text-sm text-gray-500">
            {rows.length === 0 ? 'No browser activity yet — agents will populate this in real time.' : 'No browser activity matches your filters'}
          </p>
        </div>
      )}
      {loading && filtered.length === 0 && (
        <div className="text-center py-12 text-xs text-gray-500">Loading…</div>
      )}
    </div>
  );
}
