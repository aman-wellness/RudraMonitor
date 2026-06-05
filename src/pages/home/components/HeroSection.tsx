import { Link } from 'react-router-dom';

export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center overflow-hidden bg-dark-900">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-dark-900 via-dark-800 to-emerald-900/20" />
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-emerald-500/5 rounded-full blur-[120px]" />
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-teal-500/5 rounded-full blur-[100px]" />

      <div className="relative z-10 w-full px-4 md:px-8 lg:px-12 py-20 md:py-0">
        <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-8">
          {/* Left Content */}
          <div className="w-full lg:w-[45%] text-center lg:text-left">
            {/* Badge */}
            <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-6">
              <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-xs md:text-sm text-emerald-400 font-medium">
                14-Day Free Trial &bull; No Credit Card Required
              </span>
            </div>

            {/* Headline */}
            <h1 className="text-3xl md:text-4xl lg:text-5xl xl:text-6xl font-poppins font-bold text-white leading-tight mb-6">
              Monitor Your Team&apos;s
              <br />
              <span className="text-emerald-400">Productivity</span> in
              <br />
              Real-Time
            </h1>

            {/* Subheadline */}
            <p className="text-base md:text-lg text-gray-400 mb-8 max-w-lg mx-auto lg:mx-0">
              Enterprise-grade employee monitoring for Windows, macOS &amp; Ubuntu.
              Track applications, browsers, videos, screenshots &amp; system health
              with AI-powered insights.
            </p>

            {/* CTA Buttons */}
            <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start mb-8">
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white px-6 py-3 rounded-lg font-medium transition-all duration-200 whitespace-nowrap"
              >
                Start Free Trial
                <span className="w-5 h-5 flex items-center justify-center">
                  <i className="ri-arrow-right-line" />
                </span>
              </Link>
              <a
                href="#features"
                className="inline-flex items-center justify-center gap-2 border border-dark-600 hover:border-emerald-500 text-white px-6 py-3 rounded-lg font-medium transition-all duration-200 whitespace-nowrap"
              >
                <span className="w-5 h-5 flex items-center justify-center">
                  <i className="ri-play-circle-line" />
                </span>
                Watch Demo
              </a>
            </div>

            {/* Trust badges */}
            <div className="flex items-center gap-4 justify-center lg:justify-start">
              <span className="text-xs text-gray-500">Works on:</span>
              <div className="flex items-center gap-3">
                <span className="w-6 h-6 flex items-center justify-center text-gray-400" title="Windows">
                  <i className="ri-windows-fill text-lg" />
                </span>
                <span className="w-6 h-6 flex items-center justify-center text-gray-400" title="macOS">
                  <i className="ri-apple-fill text-lg" />
                </span>
                <span className="w-6 h-6 flex items-center justify-center text-gray-400" title="Ubuntu">
                  <i className="ri-ubuntu-fill text-lg" />
                </span>
              </div>
            </div>
          </div>

          {/* Right Visual - Dashboard Preview */}
          <div className="w-full lg:w-[55%] relative">
            <div className="relative">
              {/* Main Dashboard Image */}
              <div className="relative rounded-xl overflow-hidden border border-dark-700 shadow-2xl">
                <img
                  src="https://readdy.ai/api/search-image?query=modern%20dark%20dashboard%20UI%20with%20employee%20monitoring%20charts%2C%20activity%20graphs%2C%20screenshots%20grid%2C%20system%20health%20metrics%2C%20CPU%20RAM%20usage%20bars%2C%20green%20accent%20colors%2C%20dark%20charcoal%20background%2C%20clean%20minimal%20enterprise%20design%2C%20professional%20SaaS%20admin%20panel%2C%20real-time%20monitoring%20interface&width=900&height=550&seq=hero-dash-1&orientation=landscape"
                  alt="Rudrans Dashboard Preview"
                  className="w-full h-auto object-cover"
                />
                {/* Overlay gradient */}
                <div className="absolute inset-0 bg-gradient-to-t from-dark-900/60 via-transparent to-transparent" />
              </div>

              {/* Floating card - Uptime */}
              <div className="absolute -top-4 -right-2 md:right-4 bg-dark-800/90 backdrop-blur-md border border-dark-700 rounded-lg px-4 py-3 shadow-xl">
                <div className="flex items-center gap-2">
                  <span className="w-8 h-8 flex items-center justify-center bg-emerald-500/20 rounded-lg">
                    <i className="ri-shield-check-line text-emerald-400 text-sm" />
                  </span>
                  <div>
                    <p className="text-xs text-gray-400">Uptime</p>
                    <p className="text-sm font-bold text-white">99.9%</p>
                  </div>
                </div>
              </div>

              {/* Floating card - Real-time Alert */}
              <div className="absolute top-1/2 -left-2 md:-left-6 bg-dark-800/90 backdrop-blur-md border border-dark-700 rounded-lg px-4 py-3 shadow-xl">
                <div className="flex items-center gap-2">
                  <span className="w-8 h-8 flex items-center justify-center bg-red-500/20 rounded-lg">
                    <i className="ri-notification-3-line text-red-400 text-sm" />
                  </span>
                  <div>
                    <p className="text-xs text-gray-400">Alert</p>
                    <p className="text-sm font-medium text-white">Unauthorized USB</p>
                  </div>
                </div>
              </div>

              {/* Floating card - AI Insights */}
              <div className="absolute -bottom-4 right-8 md:right-16 bg-dark-800/90 backdrop-blur-md border border-dark-700 rounded-lg px-4 py-3 shadow-xl">
                <div className="flex items-center gap-2">
                  <span className="w-8 h-8 flex items-center justify-center bg-emerald-500/20 rounded-lg">
                    <i className="ri-brain-line text-emerald-400 text-sm" />
                  </span>
                  <div>
                    <p className="text-xs text-gray-400">AI Insight</p>
                    <p className="text-sm font-medium text-white">+23% Productivity</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}