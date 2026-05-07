import { Link } from 'react-router-dom';

export default function CTASection() {
  return (
    <section className="relative bg-gradient-to-b from-dark-900 via-emerald-950/20 to-dark-900 py-20 md:py-28">
      {/* Background grid pattern */}
      <div
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage:
            'linear-gradient(rgba(16, 185, 129, 0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(16, 185, 129, 0.3) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div className="relative z-10 w-full px-4 md:px-8 lg:px-12">
        <div className="max-w-3xl mx-auto text-center">
          {/* Headline */}
          <h2 className="text-2xl md:text-3xl lg:text-4xl font-poppins font-bold text-white mb-4 leading-tight">
            Boost Your Team&apos;s Productivity Today
          </h2>

          {/* Subheadline */}
          <p className="text-sm md:text-base text-gray-400 mb-8">
            14-Day Free Trial &bull; No Credit Card Required &bull; Setup in 2 Minutes
          </p>

          {/* CTA Button */}
          <Link
            to="/signup"
            className="inline-flex items-center justify-center gap-2 bg-white hover:bg-gray-100 text-emerald-700 px-8 py-4 rounded-lg font-semibold transition-all duration-200 whitespace-nowrap text-base"
          >
            Start Free Trial
            <span className="w-5 h-5 flex items-center justify-center">
              <i className="ri-arrow-right-line" />
            </span>
          </Link>

          {/* Additional info */}
          <div className="flex items-center justify-center gap-6 mt-8">
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 flex items-center justify-center">
                <i className="ri-shield-check-line text-emerald-400 text-sm" />
              </span>
              <span className="text-xs text-gray-500">Enterprise Security</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 flex items-center justify-center">
                <i className="ri-lock-line text-emerald-400 text-sm" />
              </span>
              <span className="text-xs text-gray-500">GDPR Compliant</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 flex items-center justify-center">
                <i className="ri-customer-service-2-line text-emerald-400 text-sm" />
              </span>
              <span className="text-xs text-gray-500">24/7 Support</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}