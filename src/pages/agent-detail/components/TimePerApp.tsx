interface AppTime {
  name: string;
  percent: number;
  time: string;
  color: string;
}

interface Props {
  apps: AppTime[];
}

export default function TimePerApp({ apps }: Props) {
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 md:p-5">
      <h3 className="text-sm font-poppins font-semibold text-white mb-4">Time Per Application</h3>
      <div className="space-y-3">
        {apps.map((app) => (
          <div key={app.name} className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-24 md:w-32 text-right flex-shrink-0 truncate">{app.name}</span>
            <div className="flex-1 flex items-center gap-2">
              <div className="flex-1 h-5 bg-dark-900 rounded-md overflow-hidden">
                <div
                  className={`h-full rounded-md ${app.color} transition-all`}
                  style={{ width: `${Math.max(app.percent, 1)}%` }}
                />
              </div>
              <span className="text-xs font-semibold text-white w-8 text-right">{app.percent}%</span>
            </div>
            <span className="text-xs text-gray-500 w-16 text-right flex-shrink-0">{app.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}