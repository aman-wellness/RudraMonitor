import { useAgents, useOrgProductivityStats } from '@/lib/dataHooks';

type Stat = {
  label: string;
  value: string;
  change: string;
  trend: 'up' | 'down';
  icon: string;
  color: 'emerald' | 'amber' | 'teal';
};

export default function StatCards() {
  const { agents, loading } = useAgents();
  const { stats } = useOrgProductivityStats(24);

  const total = agents.length;
  const online = agents.filter((a) => a.status === 'online').length;
  const onlinePct = total > 0 ? Math.round((online / total) * 100) : 0;

  const pendingAlerts = stats?.pending_alerts ?? 0;
  const productivity = stats?.productivity_pct;

  const items: Stat[] = [
    {
      label: 'Total Agents',
      value: loading ? '…' : String(total),
      change: total === 0 ? 'No agents yet' : `${total} registered`,
      trend: 'up',
      icon: 'ri-computer-line',
      color: 'emerald',
    },
    {
      label: 'Active Now',
      value: loading ? '…' : String(online),
      change: total > 0 ? `${onlinePct}% online` : '—',
      trend: 'up',
      icon: 'ri-wifi-line',
      color: 'emerald',
    },
    {
      label: 'Pending Alerts',
      value: String(pendingAlerts),
      change: pendingAlerts === 0 ? 'All clear' : 'Last 24h',
      trend: pendingAlerts === 0 ? 'down' : 'up',
      icon: 'ri-notification-3-line',
      color: 'amber',
    },
    {
      label: 'Avg Productivity',
      value: productivity === null || productivity === undefined ? '—' : `${productivity}%`,
      change: productivity == null
        ? 'Waiting for data'
        : productivity >= 70 ? 'Healthy' : productivity >= 40 ? 'Mixed' : 'Needs attention',
      trend: 'up',
      icon: 'ri-bar-chart-grouped-line',
      color: 'teal',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-5">
      {items.map((stat) => (
        <div
          key={stat.label}
          className="bg-dark-800 border border-dark-700 rounded-xl p-4 md:p-5 hover:border-dark-600 transition-all duration-200 group"
        >
          <div className="flex items-start justify-between mb-3">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                stat.color === 'emerald'
                  ? 'bg-emerald-500/10'
                  : stat.color === 'amber'
                    ? 'bg-amber-500/10'
                    : 'bg-teal-500/10'
              }`}
            >
              <span className="w-5 h-5 flex items-center justify-center">
                <i
                  className={`${stat.icon} ${
                    stat.color === 'emerald'
                      ? 'text-emerald-400'
                      : stat.color === 'amber'
                        ? 'text-amber-400'
                        : 'text-teal-400'
                  } text-lg`}
                />
              </span>
            </div>
            <span
              className={`flex items-center gap-1 text-xs font-medium ${
                stat.trend === 'up' ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              <span className="w-4 h-4 flex items-center justify-center">
                <i className={stat.trend === 'up' ? 'ri-arrow-up-line' : 'ri-arrow-down-line'} />
              </span>
              {stat.trend === 'down' ? 'Down' : 'Up'}
            </span>
          </div>
          <p className="text-2xl md:text-3xl font-poppins font-bold text-white mb-1">
            {stat.value}
          </p>
          <p className="text-xs text-gray-500">{stat.label}</p>
          <p className="text-xs text-gray-600 mt-1">{stat.change}</p>
        </div>
      ))}
    </div>
  );
}
