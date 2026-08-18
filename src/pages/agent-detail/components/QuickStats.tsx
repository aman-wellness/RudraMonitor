interface Props {
  totalActiveTime: string;
  appsUsed: number;
  sitesVisited: number;
  screenshotsCount: number;
  alertsCount: number;
  sessionsCount: number;
}

export default function QuickStats({
  totalActiveTime,
  appsUsed,
  sitesVisited,
  screenshotsCount,
  alertsCount,
  sessionsCount,
}: Props) {
  const stats = [
    { label: 'ACTIVE TIME', value: totalActiveTime, sub: 'mins', icon: 'ri-time-line', color: 'text-violet-400' },
    { label: 'APPS USED', value: String(appsUsed), sub: 'unique', icon: 'ri-apps-line', color: 'text-emerald-400' },
    { label: 'SITES VISITED', value: String(sitesVisited), sub: 'unique', icon: 'ri-global-line', color: 'text-teal-400' },
    { label: 'SCREENSHOTS', value: String(screenshotsCount), sub: 'captured', icon: 'ri-image-line', color: 'text-amber-400' },
    { label: 'ALERTS', value: String(alertsCount), sub: 'triggered', icon: 'ri-notification-3-line', color: 'text-red-400' },
    { label: 'EVENTS', value: String(sessionsCount), sub: 'app + browser', icon: 'ri-stack-line', color: 'text-blue-400' },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="bg-dark-800 border border-dark-700 rounded-xl p-3 md:p-4 text-center">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1 flex items-center justify-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className={s.icon} /></span>
            {s.label}
          </p>
          <p className={`text-2xl md:text-3xl font-poppins font-bold ${s.color}`}>{s.value}</p>
          <p className="text-[10px] text-gray-500">{s.sub}</p>
        </div>
      ))}
    </div>
  );
}