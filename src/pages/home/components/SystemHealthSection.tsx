export default function SystemHealthSection() {
  const metrics = [
    { name: 'CPU Usage', value: 42, unit: '%', status: 'Normal', icon: 'ri-cpu-line' },
    { name: 'RAM Usage', value: 67, unit: '%', status: 'Warning', icon: 'ri-database-2-line' },
    { name: 'Disk Usage', value: 78, unit: '%', status: 'Warning', icon: 'ri-hard-drive-line' },
    { name: 'Battery', value: 85, unit: '%', status: 'Normal', icon: 'ri-battery-charge-line' },
    { name: 'Network', value: 95, unit: '%', status: 'Normal', icon: 'ri-wifi-line' },
    { name: 'Internet Speed', value: 245, unit: 'Mbps', status: 'Normal', icon: 'ri-speed-line' },
  ];

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Normal':
        return 'text-emerald-400';
      case 'Warning':
        return 'text-yellow-400';
      case 'Critical':
        return 'text-red-400';
      default:
        return 'text-gray-400';
    }
  };

  const getProgressColor = (value: number) => {
    if (value < 50) return 'stroke-emerald-400';
    if (value < 80) return 'stroke-yellow-400';
    return 'stroke-red-400';
  };

  return (
    <section className="relative bg-dark-800 py-16 md:py-24">
      <div className="w-full px-4 md:px-8 lg:px-12">
        {/* Section Header */}
        <div className="text-center mb-12 md:mb-16">
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-4">
            <i className="ri-heart-pulse-line text-emerald-400 text-sm" />
            <span className="text-xs md:text-sm text-emerald-400 font-medium">
              System Health
            </span>
          </div>
          <h2 className="text-2xl md:text-3xl lg:text-4xl font-poppins font-bold text-white mb-4">
            Real-Time System Health Insights
          </h2>
          <p className="text-sm md:text-base text-gray-400 max-w-2xl mx-auto">
            Monitor CPU, RAM, Disk, Battery, Network & Internet Speed in real-time.
            Get AI-powered improvement recommendations.
          </p>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 md:gap-5">
          {metrics.map((metric) => (
            <div
              key={metric.name}
              className="bg-dark-900 border border-dark-700 rounded-lg p-5 md:p-6 hover:border-emerald-500/30 transition-all duration-300"
            >
              {/* Icon and Name */}
              <div className="flex items-center gap-3 mb-4">
                <span className="w-10 h-10 flex items-center justify-center bg-dark-800 rounded-lg">
                  <i className={`${metric.icon} text-emerald-400 text-lg`} />
                </span>
                <div>
                  <p className="text-sm font-medium text-white">{metric.name}</p>
                  <p className={`text-xs ${getStatusColor(metric.status)}`}>
                    {metric.status}
                  </p>
                </div>
              </div>

              {/* Circular Progress */}
              <div className="flex items-center justify-center py-2">
                <div className="relative w-24 h-24 md:w-28 md:h-28">
                  <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                    <circle
                      cx="50"
                      cy="50"
                      r="42"
                      fill="none"
                      stroke="#333333"
                      strokeWidth="6"
                    />
                    <circle
                      cx="50"
                      cy="50"
                      r="42"
                      fill="none"
                      className={getProgressColor(
                        metric.unit === '%' ? metric.value : (metric.value / 300) * 100
                      )}
                      strokeWidth="6"
                      strokeLinecap="round"
                      strokeDasharray={`${
                        (metric.unit === '%' ? metric.value : (metric.value / 300) * 100) * 2.64
                      } 264`}
                      style={{ transition: 'stroke-dasharray 0.5s ease' }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-lg md:text-xl font-bold text-white">
                      {metric.value}
                    </span>
                    <span className="text-xs text-gray-500">{metric.unit}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Recommendation Banner */}
        <div className="mt-8 bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border border-emerald-500/20 rounded-lg p-5 md:p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <span className="w-12 h-12 flex items-center justify-center bg-emerald-500/20 rounded-xl flex-shrink-0">
            <i className="ri-lightbulb-flash-line text-emerald-400 text-xl" />
          </span>
          <div className="flex-1">
            <p className="text-sm font-medium text-white mb-1">
              AI Recommendation
            </p>
            <p className="text-sm text-gray-400">
              RAM usage is consistently above 65%. Consider upgrading RAM or closing unused applications during peak hours for better performance.
            </p>
          </div>
          <button className="px-5 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm rounded-md transition-all whitespace-nowrap">
            View Details
          </button>
        </div>
      </div>
    </section>
  );
}