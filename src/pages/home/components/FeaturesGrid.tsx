import { features } from '@/mocks/features';

export default function FeaturesGrid() {
  return (
    <section id="features" className="relative bg-dark-900 py-16 md:py-24">
      <div className="w-full px-4 md:px-8 lg:px-12">
        {/* Section Header */}
        <div className="text-center mb-12 md:mb-16">
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-4">
            <i className="ri-star-smile-line text-emerald-400 text-sm" />
            <span className="text-xs md:text-sm text-emerald-400 font-medium">
              Powerful Features
            </span>
          </div>
          <h2 className="text-2xl md:text-3xl lg:text-4xl font-poppins font-bold text-white mb-4">
            Complete Control Over Every Activity
          </h2>
          <p className="text-sm md:text-base text-gray-400 max-w-2xl mx-auto">
            Enterprise-grade monitoring solution with AI-powered insights for modern teams
          </p>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
          {features.map((feature) => (
            <div
              key={feature.id}
              className="group relative bg-dark-800 border border-dark-700 rounded-lg p-5 md:p-6 hover:border-emerald-500/40 hover:-translate-y-1 transition-all duration-300"
            >
              {/* Icon */}
              <div className="w-12 h-12 flex items-center justify-center bg-gradient-to-br from-emerald-500/20 to-teal-500/20 rounded-lg mb-4 group-hover:from-emerald-500/30 group-hover:to-teal-500/30 transition-all">
                <span className="w-6 h-6 flex items-center justify-center">
                  <i className={`${feature.icon} text-emerald-400 text-lg`} />
                </span>
              </div>

              {/* Title */}
              <h3 className="text-base md:text-lg font-poppins font-semibold text-white mb-2">
                {feature.title}
              </h3>

              {/* Description */}
              <p className="text-sm text-gray-400 leading-relaxed">
                {feature.description}
              </p>

              {/* Learn more link */}
              <div className="mt-4 flex items-center gap-1 text-sm text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <span>Learn more</span>
                <span className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-arrow-right-line text-xs" />
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}