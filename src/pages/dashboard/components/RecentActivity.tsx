import { Link } from 'react-router-dom';
import { useActivityLogs } from '@/lib/dataHooks';

const formatTime = (iso: string) => {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

const severityFor = (type: string): 'info' | 'warning' | 'error' => {
  if (type === 'idle') return 'warning';
  if (type === 'alert') return 'error';
  return 'info';
};

const labelFor = (type: string) => {
  switch (type) {
    case 'app': return 'App Switch';
    case 'browser': return 'Browser';
    case 'idle': return 'Idle';
    case 'screenshot': return 'Screenshot';
    case 'alert': return 'Alert';
    default: return type;
  }
};

const detailFor = (r: { activity_type: string; application_name: string | null; url: string | null; duration: number | null }) => {
  if (r.activity_type === 'idle') {
    const m = Math.floor((r.duration ?? 0) / 60);
    return `Idle for ${m}m`;
  }
  if (r.activity_type === 'screenshot') return 'Screenshot captured';
  if (r.activity_type === 'browser') return r.url ?? 'Browser activity';
  if (r.activity_type === 'app') return `Switched to ${r.application_name ?? 'app'}`;
  return r.url ?? r.application_name ?? '';
};

export default function RecentActivity() {
  const { rows, loading } = useActivityLogs({ sinceHours: 24, limit: 30 });

  const getSeverityIcon = (severity: 'info' | 'warning' | 'error') => {
    switch (severity) {
      case 'error':
        return (
          <span className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center flex-shrink-0">
            <i className="ri-error-warning-line text-red-400 text-sm" />
          </span>
        );
      case 'warning':
        return (
          <span className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center flex-shrink-0">
            <i className="ri-alert-line text-amber-400 text-sm" />
          </span>
        );
      default:
        return (
          <span className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
            <i className="ri-information-line text-emerald-400 text-sm" />
          </span>
        );
    }
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
      <div className="p-4 md:p-5 border-b border-dark-700 flex items-center justify-between">
        <h3 className="text-sm md:text-base font-poppins font-semibold text-white">Recent Activity</h3>
        <Link to="/monitoring" className="text-xs text-emerald-400 hover:text-emerald-300 font-medium transition-colors">
          View all
        </Link>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {!loading && rows.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-gray-500">
            No activity yet — agents will populate this in real time.
          </div>
        )}
        {loading && rows.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-gray-500">Loading…</div>
        )}
        {rows.map((activity) => (
          <div key={activity.id} className="flex items-start gap-3 px-4 py-3 border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors">
            {getSeverityIcon(severityFor(activity.activity_type))}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-gray-500 font-medium">{activity.agent_name || 'Unknown'}</span>
                <span className="text-[10px] text-emerald-500/80 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                  {labelFor(activity.activity_type)}
                </span>
              </div>
              <p className="text-xs text-gray-300 leading-relaxed truncate">{detailFor(activity)}</p>
            </div>
            <span className="text-xs text-gray-600 flex-shrink-0">{formatTime(activity.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
