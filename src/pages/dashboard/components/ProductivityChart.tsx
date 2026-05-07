import { useState } from 'react';
import { useOrgProductivityDaily } from '@/lib/dataHooks';

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function ProductivityChart() {
  const [chartType, setChartType] = useState<'productivity' | 'agents'>('productivity');
  const { rows, loading } = useOrgProductivityDaily(7);

  const data = rows.map((r) => ({
    day: DAYS_SHORT[new Date(r.day_bucket + 'T00:00:00Z').getUTCDay()] ?? '',
    productivity: r.productivity_pct,
    agents: r.active_agents,
  }));

  const maxVal = chartType === 'productivity' ? 100 : Math.max(1, ...data.map((d) => d.agents));

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 md:p-5">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-5">
        <h3 className="text-sm md:text-base font-poppins font-semibold text-white">Weekly Overview</h3>
        <div className="flex items-center bg-dark-900 rounded-lg p-1">
          <button
            onClick={() => setChartType('productivity')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              chartType === 'productivity' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            Productivity
          </button>
          <button
            onClick={() => setChartType('agents')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              chartType === 'agents' ? 'bg-emerald-500/20 text-emerald-400' : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            Active Agents
          </button>
        </div>
      </div>

      {loading && data.length === 0 ? (
        <div className="h-48 md:h-56 flex items-center justify-center text-xs text-gray-500">Loading…</div>
      ) : (
        <div className="flex items-end gap-3 h-48 md:h-56 px-2">
          {data.map((item, i) => {
            const val = chartType === 'productivity' ? item.productivity : item.agents;
            const height = (val / maxVal) * 100;
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-2">
                <div className="w-full relative h-full flex items-end">
                  <div
                    className="w-full bg-emerald-500/80 hover:bg-emerald-400 rounded-t-md transition-all duration-300 cursor-pointer min-h-[4px]"
                    style={{ height: `${height}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500 font-medium">{item.day}</span>
                <span className="text-xs text-emerald-400 font-semibold">
                  {val}{chartType === 'productivity' ? '%' : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
