import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useAlerts } from '@/lib/dataHooks';

const alertTabs = ['All', 'Error', 'Warning', 'Info'] as const;
type AlertTab = (typeof alertTabs)[number];

const formatRelative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

export default function AlertsPage() {
  const navigate = useNavigate();
  const { rows: allAlerts, loading, resolveAlert } = useAlerts({ sinceHours: 24 * 7 });
  const [tab, setTab] = useState<AlertTab>('All');
  const [search, setSearch] = useState('');
  const [resolvedOnly, setResolvedOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return allAlerts.filter((a) => {
      const matchesTab = tab === 'All' || a.alert_type === tab.toLowerCase();
      const matchesSearch = search === ''
        || a.message.toLowerCase().includes(search.toLowerCase())
        || (a.agent_name ?? '').toLowerCase().includes(search.toLowerCase());
      const matchesResolved = !resolvedOnly || a.ai_resolved;
      return matchesTab && matchesSearch && matchesResolved;
    });
  }, [allAlerts, tab, search, resolvedOnly]);

  const stats = [
    { label: 'Total', value: allAlerts.length, icon: 'ri-notification-3-line', color: 'text-white' },
    { label: 'Critical', value: allAlerts.filter((a) => a.alert_type === 'error').length, icon: 'ri-error-warning-line', color: 'text-red-400' },
    { label: 'Warnings', value: allAlerts.filter((a) => a.alert_type === 'warning').length, icon: 'ri-alarm-warning-line', color: 'text-amber-400' },
    { label: 'Resolved', value: allAlerts.filter((a) => a.ai_resolved).length, icon: 'ri-check-double-line', color: 'text-emerald-400' },
  ];

  const getIcon = (type: string) => {
    switch (type) {
      case 'error': return 'ri-error-warning-line text-red-400';
      case 'warning': return 'ri-alarm-warning-line text-amber-400';
      default: return 'ri-information-line text-blue-400';
    }
  };
  const getBadge = (type: string) => {
    switch (type) {
      case 'error': return 'bg-red-500/15 text-red-400 border border-red-500/20';
      case 'warning': return 'bg-amber-500/15 text-amber-400 border border-amber-500/20';
      default: return 'bg-blue-500/15 text-blue-400 border border-blue-500/20';
    }
  };

  const onResolve = async (alertId: string) => {
    setResolving(alertId);
    try {
      await resolveAlert(alertId, 'Marked resolved by admin');
    } finally {
      setResolving(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-dashboard-line" /></span>
            Dashboard
          </span>
          <i className="ri-arrow-right-s-line text-gray-600" />
          <span className="text-white font-medium">Alerts</span>
        </div>

        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-poppins font-bold text-white mb-1">Alerts</h1>
            <p className="text-sm text-gray-500">{filtered.length} alerts in the selected view</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setResolvedOnly(!resolvedOnly)}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${resolvedOnly ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25' : 'bg-dark-800 text-gray-400 border-dark-700 hover:bg-dark-700'}`}
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center"><i className="ri-check-line text-xs" /></span>
              Resolved Only
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          {stats.map((s) => (
            <div key={s.label} className="bg-dark-800 border border-dark-700 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-8 h-8 rounded-lg bg-dark-700 flex items-center justify-center">
                  <span className="w-4 h-4 flex items-center justify-center"><i className={`${s.icon} ${s.color} text-sm`} /></span>
                </span>
              </div>
              <p className="text-xl font-poppins font-bold text-white">{s.value}</p>
              <p className="text-[11px] text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
          <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg p-1">
            {alertTabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-all ${tab === t ? 'bg-dark-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 w-full sm:w-auto sm:min-w-[240px]">
            <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
              <i className="ri-search-line text-sm" />
            </span>
            <input
              type="text"
              placeholder="Search alerts, agents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none w-full"
            />
          </div>
        </div>

        <div className="space-y-2">
          {filtered.map((alert) => (
            <div
              key={alert.id}
              className={`bg-dark-800 border rounded-xl overflow-hidden transition-all ${alert.alert_type === 'error' ? 'border-red-500/20' : alert.alert_type === 'warning' ? 'border-amber-500/20' : 'border-dark-700'}`}
            >
              <div
                onClick={() => setExpandedId(expandedId === alert.id ? null : alert.id)}
                className="p-4 md:p-5 flex items-start gap-3 md:gap-4 cursor-pointer hover:bg-dark-700/20 transition-colors"
              >
                <span className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${alert.alert_type === 'error' ? 'bg-red-500/10' : alert.alert_type === 'warning' ? 'bg-amber-500/10' : 'bg-blue-500/10'}`}>
                  <span className="w-5 h-5 flex items-center justify-center"><i className={`${getIcon(alert.alert_type)} text-lg`} /></span>
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${getBadge(alert.alert_type)}`}>
                      {alert.alert_type.toUpperCase()}
                    </span>
                    <span className="text-[11px] text-gray-500">{formatRelative(alert.created_at)}</span>
                    {alert.ai_resolved && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                        <span className="w-3 h-3 flex items-center justify-center"><i className="ri-check-double-line" /></span>
                        Resolved
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-white font-medium mb-1">{alert.message}</p>
                  <p className="text-xs text-gray-500">{alert.agent_name || 'Unknown agent'}</p>
                </div>
                <span className="w-5 h-5 flex items-center justify-center text-gray-500 flex-shrink-0">
                  <i className={`ri-arrow-down-s-line text-lg transition-transform ${expandedId === alert.id ? 'rotate-180' : ''}`} />
                </span>
              </div>

              {expandedId === alert.id && (
                <div className="px-4 md:px-5 pb-4 md:pb-5 pt-0 border-t border-dark-700/50">
                  <div className="mt-3 space-y-3">
                    {alert.ai_resolved && alert.resolution && (
                      <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="w-4 h-4 flex items-center justify-center"><i className="ri-check-double-line text-emerald-400 text-xs" /></span>
                          <span className="text-xs text-emerald-400 font-medium">Resolution</span>
                        </div>
                        <p className="text-xs text-gray-400">{alert.resolution}</p>
                      </div>
                    )}
                    {!alert.ai_resolved && (
                      <div className="bg-amber-500/5 border border-amber-500/15 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="w-4 h-4 flex items-center justify-center"><i className="ri-user-line text-amber-400 text-xs" /></span>
                          <span className="text-xs text-amber-400 font-medium">Pending review</span>
                        </div>
                        <p className="text-xs text-gray-400">Review the alert and mark resolved once handled.</p>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); navigate(`/agents/${alert.agent_id}`); }}
                        className="px-3 py-1.5 rounded-lg bg-dark-700 text-gray-300 text-xs font-medium border border-dark-600 hover:bg-dark-600 transition-colors flex items-center gap-1.5"
                      >
                        <span className="w-3 h-3 flex items-center justify-center"><i className="ri-user-line text-xs" /></span>
                        View Agent
                      </button>
                      {!alert.ai_resolved && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void onResolve(alert.id); }}
                          disabled={resolving === alert.id}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/25 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                        >
                          <span className="w-3 h-3 flex items-center justify-center"><i className="ri-check-line text-xs" /></span>
                          {resolving === alert.id ? 'Resolving…' : 'Mark Resolved'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {!loading && filtered.length === 0 && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-12 text-center">
            <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
              <i className="ri-shield-check-line text-3xl" />
            </span>
            <p className="text-sm text-gray-500">
              {allAlerts.length === 0 ? 'No alerts in the last 7 days — agents auto-fire on CPU/RAM/disk thresholds.' : 'No alerts match your filters'}
            </p>
          </div>
        )}
        {loading && allAlerts.length === 0 && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-12 text-center text-xs text-gray-500">Loading…</div>
        )}
      </div>
    </DashboardLayout>
  );
}
