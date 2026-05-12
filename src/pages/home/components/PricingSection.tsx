import { useState } from 'react';
import { Link } from 'react-router-dom';
import { pricingPlans, dlpAddon, enterpriseTier } from '@/mocks/pricing';

type Currency = 'INR' | 'USD';

export default function PricingSection() {
  // Default to INR (primary market). Toggle exposes USD for international visitors.
  const [currency, setCurrency] = useState<Currency>('INR');

  const fmt = (inr: number, usd: number) => {
    if (currency === 'INR') return `₹${inr.toLocaleString('en-IN')}`;
    return `$${usd.toLocaleString('en-US')}`;
  };

  return (
    <section id="pricing" className="relative bg-dark-900 py-16 md:py-24">
      <div className="w-full px-4 md:px-8 lg:px-12 max-w-7xl mx-auto">
        {/* Section Header */}
        <div className="text-center mb-10 md:mb-14">
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-4">
            <i className="ri-price-tag-3-line text-emerald-400 text-sm" />
            <span className="text-xs md:text-sm text-emerald-400 font-medium">Pricing</span>
          </div>
          <h2 className="text-2xl md:text-3xl lg:text-4xl font-poppins font-bold text-white mb-4">
            Yearly plans with included seats
          </h2>
          <p className="text-sm md:text-base text-gray-400 max-w-2xl mx-auto mb-6">
            Pick the seat tier that matches your team. Every plan ships with the same core features —
            higher tiers unlock video recording, multi-portal access, longer retention and more seats.
            14-day free trial, no credit card.
          </p>

          {/* Currency toggle */}
          <div className="inline-flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-full p-1">
            <button
              onClick={() => setCurrency('INR')}
              className={`px-5 py-1.5 rounded-full text-xs font-medium transition-all ${
                currency === 'INR' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              ₹ INR
            </button>
            <button
              onClick={() => setCurrency('USD')}
              className={`px-5 py-1.5 rounded-full text-xs font-medium transition-all ${
                currency === 'USD' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              $ USD
            </button>
          </div>
        </div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
          {pricingPlans.map((plan) => (
            <div
              key={plan.id}
              className={`relative bg-dark-800 border rounded-2xl p-6 md:p-7 transition-all duration-300 ${
                plan.highlighted
                  ? 'border-emerald-500/60 shadow-2xl shadow-emerald-500/10'
                  : 'border-dark-700 hover:border-emerald-500/30'
              }`}
            >
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-emerald-500 text-white text-[11px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full">
                    Most Popular
                  </span>
                </div>
              )}

              {/* Plan name */}
              <div className="text-center mb-5 pt-2">
                <h3 className="text-lg font-poppins font-bold text-white mb-1">{plan.name}</h3>
                <p className="text-xs text-gray-500 leading-relaxed">{plan.description}</p>
              </div>

              {/* Price */}
              <div className="text-center mb-6">
                <div>
                  <span className="text-3xl md:text-4xl font-bold text-white tabular-nums">
                    {fmt(plan.priceInr, plan.priceUsd)}
                  </span>
                  <span className="text-sm text-gray-500 ml-1.5">/ year</span>
                </div>
                <p className="text-[11px] text-gray-500 mt-2">
                  <span className="text-emerald-400 font-medium">{plan.seatCount} agents</span> included
                </p>
                <p className="text-[11px] text-gray-600 mt-0.5">
                  ≈ {fmt(Math.round(plan.priceInr / plan.seatCount / 12), Math.round(plan.priceUsd / plan.seatCount / 12 * 100) / 100)} per agent / month
                </p>
              </div>

              {/* Features */}
              <ul className="space-y-2.5 mb-7">
                {plan.features.map((feature, idx) => (
                  <li key={idx} className="flex items-start gap-2.5">
                    <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <i className="ri-check-line text-emerald-400 text-sm" />
                    </span>
                    <span className="text-[13px] text-gray-300 leading-relaxed">{feature}</span>
                  </li>
                ))}
              </ul>

              <Link
                to="/signup"
                className={`block text-center w-full py-2.5 rounded-lg font-medium text-sm transition-all duration-200 whitespace-nowrap ${
                  plan.highlighted
                    ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'
                    : 'border border-dark-600 hover:border-emerald-500 text-white hover:text-emerald-400'
                }`}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>

        {/* DLP add-on banner */}
        <div className="mt-10 bg-dark-800 border border-dark-700 rounded-2xl overflow-hidden">
          <div className="grid md:grid-cols-[1fr_auto] items-stretch">
            <div className="p-6 md:p-8">
              <div className="flex items-center gap-2 mb-3">
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                  Add-on
                </span>
                <h3 className="text-lg font-poppins font-bold text-white">{dlpAddon.name}</h3>
              </div>
              <p className="text-sm text-gray-400 mb-4">{dlpAddon.description}</p>
              <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
                {dlpAddon.features.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <i className="ri-check-line text-cyan-400 text-sm mt-0.5" />
                    <span className="text-[13px] text-gray-300">{f}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="md:w-64 flex flex-col items-center justify-center bg-dark-900 p-6 md:p-8 border-t md:border-t-0 md:border-l border-dark-700 text-center">
              <p className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">Per agent / month</p>
              <p className="text-3xl font-bold text-white tabular-nums">
                +{fmt(dlpAddon.pricePerAgentInr, dlpAddon.pricePerAgentUsd)}
              </p>
              <p className="text-[11px] text-gray-500 mt-2">Toggle per agent, billed monthly</p>
              <Link
                to="/signup"
                className="mt-4 px-4 py-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-300 text-xs font-medium"
              >
                Enable DLP
              </Link>
            </div>
          </div>
        </div>

        {/* Enterprise tier — contact-only */}
        <div className="mt-6 bg-gradient-to-br from-dark-800 to-dark-900 border border-dark-700 rounded-2xl p-6 md:p-8">
          <div className="grid md:grid-cols-[1fr_auto] gap-6 items-center">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-violet-500/15 text-violet-300 border border-violet-500/30">
                  Contact sales
                </span>
                <h3 className="text-lg font-poppins font-bold text-white">{enterpriseTier.name}</h3>
              </div>
              <p className="text-sm text-gray-400 mb-3">{enterpriseTier.description}</p>
              <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
                {enterpriseTier.features.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12px] text-gray-300">
                    <i className="ri-check-line text-violet-400 text-sm mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
            <Link
              to="/#contact"
              className="px-5 py-3 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/30 text-violet-300 text-sm font-medium whitespace-nowrap"
            >
              {enterpriseTier.cta}
            </Link>
          </div>
        </div>

        {/* Fine print */}
        <p className="text-center text-[11px] text-gray-500 mt-8 max-w-3xl mx-auto leading-relaxed">
          All Indian customers are billed in INR with 18% GST. International customers in USD.
          Annual subscriptions only. Need a custom tier between Growth (25 agents) and Scale (100 agents)?
          We can issue a pro-rated invoice — talk to sales.
        </p>
      </div>
    </section>
  );
}
