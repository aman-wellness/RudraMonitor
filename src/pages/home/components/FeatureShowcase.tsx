export default function FeatureShowcase() {
  const showcases = [
    {
      id: 1,
      badge: 'Real-Time Tracking',
      title: 'Every Application at Your Fingertips',
      description: 'Get complete visibility into all applications running on employee systems. Track usage time, activity logs, and detect unauthorized access instantly.',
      points: [
        'Live monitoring of all applications',
        'Usage time and activity logs',
        'Unauthorized access detection',
        'Application categorization',
      ],
      image: 'https://readdy.ai/api/search-image?query=dark%20themed%20application%20monitoring%20dashboard%20showing%20running%20apps%20list%2C%20usage%20statistics%20bar%20charts%2C%20time%20tracking%20graphs%2C%20green%20accent%20on%20dark%20charcoal%20background%2C%20enterprise%20SaaS%20UI%2C%20clean%20modern%20minimal%20design%2C%20professional%20monitoring%20interface&width=700&height=500&seq=feat-app-1&orientation=landscape',
      imageLeft: true,
    },
    {
      id: 2,
      badge: 'Browser + Video',
      title: 'Browser Activity & Video Recording',
      description: 'Monitor all browser activity across every installed browser. Auto-capture 10-minute video clips to detect unauthorized data sharing activities.',
      points: [
        'Track all browser sessions',
        'Website visit timeline',
        '10-min auto video recording',
        'Detect unauthorized data sharing',
      ],
      image: 'https://readdy.ai/api/search-image?query=dark%20themed%20browser%20monitoring%20interface%20with%20website%20visit%20timeline%2C%20video%20recording%20thumbnails%2C%20browser%20tabs%20tracking%2C%20green%20accent%20highlights%20on%20dark%20charcoal%20background%2C%20enterprise%20SaaS%20dashboard%2C%20modern%20minimal%20clean%20UI%20design&width=700&height=500&seq=feat-browser-1&orientation=landscape',
      imageLeft: false,
    },
    {
      id: 3,
      badge: 'AI Analytics',
      title: 'AI-Powered Performance Insights',
      description: 'Our AI analyzes all employee activities and generates comprehensive performance reports with charts, trends, and actionable recommendations up to 1 year.',
      points: [
        'Performance trend analysis',
        '1-year historical reports',
        'Productivity scoring',
        'AI-driven recommendations',
      ],
      image: 'https://readdy.ai/api/search-image?query=dark%20themed%20AI%20analytics%20dashboard%20with%20performance%20charts%2C%20line%20graphs%2C%20bar%20charts%2C%20productivity%20metrics%2C%20green%20accent%20on%20dark%20charcoal%20background%2C%20enterprise%20SaaS%20reporting%20interface%2C%20modern%20clean%20minimal%20design&width=700&height=500&seq=feat-ai-1&orientation=landscape',
      imageLeft: true,
    },
  ];

  return (
    <section className="relative bg-dark-900 py-16 md:py-24">
      <div className="w-full px-4 md:px-8 lg:px-12">
        <div className="space-y-20 md:space-y-28">
          {showcases.map((item) => (
            <div
              key={item.id}
              className={`flex flex-col ${
                item.imageLeft ? 'lg:flex-row' : 'lg:flex-row-reverse'
              } items-center gap-10 lg:gap-16`}
            >
              {/* Image */}
              <div className="w-full lg:w-[55%]">
                <div className="relative rounded-xl overflow-hidden border border-dark-700 shadow-2xl">
                  <img
                    src={item.image}
                    alt={item.title}
                    className="w-full h-auto object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-dark-900/30 via-transparent to-transparent" />
                </div>
              </div>

              {/* Content */}
              <div className="w-full lg:w-[45%]">
                <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-3 py-1.5 mb-4">
                  <i className="ri-flashlight-line text-emerald-400 text-xs" />
                  <span className="text-xs text-emerald-400 font-medium">
                    {item.badge}
                  </span>
                </div>
                <h3 className="text-xl md:text-2xl lg:text-3xl font-poppins font-bold text-white mb-4">
                  {item.title}
                </h3>
                <p className="text-sm md:text-base text-gray-400 mb-6 leading-relaxed">
                  {item.description}
                </p>
                <ul className="space-y-3">
                  {item.points.map((point, idx) => (
                    <li key={idx} className="flex items-start gap-3">
                      <span className="w-5 h-5 flex items-center justify-center bg-emerald-500/20 rounded-md mt-0.5 flex-shrink-0">
                        <i className="ri-check-line text-emerald-400 text-xs" />
                      </span>
                      <span className="text-sm text-gray-300">{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}