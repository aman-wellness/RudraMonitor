import { useState } from 'react';
import { pricingPlans } from '@/mocks/pricing';

export default function PricingSection() {
  const [isYearly, setIsYearly] = useState(false);

  return (
    <section id="pricing" className="relative bg-dark-900 py-16 md:py-24">
      <div className="w-full px-4 md:px-8 lg:px-12">
        {/* Section Header */}
        <div className="text-center mb-10 md:mb-14">
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-4">
            <i className="ri-price-tag-3-line text-emerald-400 text-sm" />
            <span className="text-xs md:text-sm text-emerald-400 font-medium">
              Pricing Plans
            </span>
          </div>
          <h2 className="text-2xl md:text-3xl lg:text-4xl font-poppins font-bold text-white mb-4">
            Choose the Right Plan for Your Business
          </h2>
          <p className="text-sm md:text-base text-gray-400 max-w-2xl mx-auto mb-8">
            Per agent/user licensing. Start with a 14-day free trial, no credit card required.
          </p>

          {/* Toggle */}
          <div className="inline-flex items-center gap-3 bg-dark-800 rounded-full p-1">
            <button
              onClick={() => setIsYearly(false)}
              className={`px-5 py-2 rounded-full text-sm font-medium transition-all duration-200 whitespace-nowrap ${
                !isYearly
                  ? 'bg-emerald-500 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setIsYearly(true)}
              className={`px-5 py-2 rounded-full text-sm font-medium transition-all duration-200 whitespace-nowrap ${
                isYearly
                  ? 'bg-emerald-500 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Yearly
            </button>
            <span className="text-xs text-emerald-400 mr-3">Save 20%</span>
          </div>
        </div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
          {pricingPlans.map((plan) => (
            <div
              key={plan.id}
              className={`relative bg-dark-800 border rounded-lg p-6 md:p-8 transition-all duration-300 ${
                plan.highlighted
                  ? 'border-emerald-500/50 shadow-lg shadow-emerald-500/10'
                  : 'border-dark-700 hover:border-emerald-500/30'
              }`}
            >
              {/* Popular badge */}
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-emerald-500 text-white text-xs font-medium px-4 py-1 rounded-full whitespace-nowrap">
                    Most Popular
                  </span>
                </div>
              )}

              {/* Plan Name */}
              <div className="text-center mb-6 pt-2">
                <h3 className="text-lg font-poppins font-semibold text-white mb-1">
                  {plan.name}
                </h3>
                <p className="text-sm text-gray-500">{plan.description}</p>
              </div>

              {/* Price */}
              <div className="text-center mb-6">
                {plan.monthlyPrice ? (
                  <div>
                    <span className="text-3xl md:text-4xl font-bold text-white">
                      ${isYearly ? plan.yearlyPrice : plan.monthlyPrice}
                    </span>
                    <span className="text-sm text-gray-500 ml-1">/user/month</span>
                    {isYearly && (
                      <p className="text-xs text-emerald-400 mt-1">
                        Billed annually
                      </p>
                    )}
                  </div>
                ) : (
                  <span className="text-2xl md:text-3xl font-bold text-white">
                    Custom Pricing
                  </span>
                )}
              </div>

              {/* Features */}
              <ul className="space-y-3 mb-8">
                {plan.features.map((feature, idx) => (
                  <li key={idx} className="flex items-start gap-3">
                    <span className="w-5 h-5 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <i className="ri-check-line text-emerald-400 text-sm" />
                    </span>
                    <span className="text-sm text-gray-300">{feature}</span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <button
                className={`w-full py-3 rounded-lg font-medium transition-all duration-200 whitespace-nowrap ${
                  plan.highlighted
                    ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                    : 'border border-dark-600 hover:border-emerald-500 text-white hover:text-emerald-400'
                }`}
              >
                {plan.cta}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}