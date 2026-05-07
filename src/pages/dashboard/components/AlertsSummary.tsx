import { Link } from 'react-router-dom';
import { useAlerts } from '@/lib/dataHooks';

const formatRelative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

export default function AlertsSummary() {
  const { rows, loading } = useAlerts({ sinceHours: 24, limit: 8 });

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
      <div className="p-4 md:p-5 border-b border-dark-700 flex items-center justify-between">
        <h3 className="text-sm md:text-base font-poppins font-semibold text-white">Recent Alerts</h3>
        <Link to="/alerts" className="text-xs text-emerald-400 hover:text-emerald-300 font-medium transition-colors">
          View all
        </Link>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {!loading && rows.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-gray-500">
            No alerts in the last 24 hours.
          </div>
        )}
        {loading && rows.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-gray-500">Loading…</div>
        )}
        {rows.map((alert) => (
          <div key={alert.id} className="px-4 py-3 border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
            <div className="flex items-start gap-3">
              <span
                className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                  alert.alert_type === 'error' ? 'bg-red-500' : alert.alert_type === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                }`}
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-300 leading-relaxed mb-1">{alert.message}</p>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] text-gray-500">{alert.agent_name}</span>
                  <span className="text-[10px] text-gray-600">{formatRelative(alert.created_at)}</span>
                </div>
                {alert.ai_resolved ? (
                  <div className="flex items-start gap-2 bg-emerald-500/5 border border-emerald-500/10 rounded-lg px-2.5 py-1.5">
                    <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <i className="ri-check-double-line text-emerald-400 text-xs" />
                    </span>
                    <div>
                      <p className="text-[10px] text-emerald-400 font-medium">Resolved</p>
                      {alert.resolution && (
                        <p className="text-[10px] text-gray-500">{alert.resolution}</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 bg-amber-500/5 border border-amber-500/10 rounded-lg px-2.5 py-1.5">
                    <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                      <i className="ri-loader-2-line text-amber-400 text-xs" />
                    </span>
                    <span className="text-[10px] text-amber-400">Pending review</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
