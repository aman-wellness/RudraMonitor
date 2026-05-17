import { useState } from 'react';
import { Link } from 'react-router-dom';
import { pricingPlans, dlpAddon, enterpriseTier, employeeManagementPlan, employeeManagementAddon } from '@/mocks/pricing';

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

        {/* Compact add-ons row — three side-by-side cards instead of stacked banners */}
        <div className="mt-10">
          <div className="text-center mb-5">
            <h3 className="text-lg md:text-xl font-poppins font-semibold text-white">Add-ons & standalone modules</h3>
            <p className="text-xs text-gray-500 mt-1">Mix &amp; match on any plan. No hidden fees.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* EM standalone */}
            <AddonCard
              tint="emerald"
              badge="Standalone"
              title={employeeManagementPlan.name}
              price={`${fmt(employeeManagementPlan.priceInr, employeeManagementPlan.priceUsd)} / month`}
              priceNote="Unlimited users"
              description="Full IT lifecycle suite — provisioning, credentials vault, hardware, offboarding. Run without any monitoring agents."
              bullets={employeeManagementPlan.features.slice(0, 5)}
              cta="Start free"
              ctaHref="/signup"
            />
            {/* EM add-on */}
            <AddonCard
              tint="violet"
              badge="Add-on"
              title="Employee Management"
              price={`+${fmt(employeeManagementAddon.priceInr, employeeManagementAddon.priceUsd)} / month`}
              priceNote="Stacks on any plan"
              description="Layer the EM suite on top of your monitoring plan. Unlimited users, one invoice line item."
              bullets={[
                'Microsoft 365 + Google connect',
                'Credentials vault + request flow',
                'IT hardware inventory',
                'Groups & Teams manager',
                '4-stage offboarding with NOC',
              ]}
              cta="Add EM"
              ctaHref="/signup"
            />
            {/* DLP add-on */}
            <AddonCard
              tint="cyan"
              badge="Add-on"
              title="DLP — USB + Email"
              price={`+${fmt(dlpAddon.pricePerAgentInr, dlpAddon.pricePerAgentUsd)} / agent / mo`}
              priceNote="Toggle per agent"
              description="AI-classified data-loss prevention. USB transfers + personal-mail attachments alerted in real time."
              bullets={[
                'USB file copy detection',
                'Personal-mail attachment monitor',
                'Claude + GPT classification',
                'Authorized-domains whitelist',
                'Severity-tiered email alerts',
              ]}
              cta="Enable DLP"
              ctaHref="/signup"
            />
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
          Indian customers billed in INR (+ 18% GST). International customers billed in USD.
          14-day free trial, no card required. Cancel anytime from the admin portal.
        </p>
      </div>
    </section>
  );
}

// ---- Compact add-on card used in the add-ons row ----

function AddonCard({
  tint, badge, title, price, priceNote, description, bullets, cta, ctaHref,
}: {
  tint: 'emerald' | 'violet' | 'cyan';
  badge: string;
  title: string;
  price: string;
  priceNote: string;
  description: string;
  bullets: string[];
  cta: string;
  ctaHref: string;
}) {
  const t = {
    emerald: { ring: 'border-emerald-500/25', badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', check: 'text-emerald-400', btn: 'bg-emerald-500 hover:bg-emerald-400 text-white' },
    violet:  { ring: 'border-violet-500/25',  badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30',  check: 'text-violet-400',  btn: 'bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/30 text-violet-200' },
    cyan:    { ring: 'border-cyan-500/25',    badge: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',       check: 'text-cyan-400',    btn: 'bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-cyan-200' },
  }[tint];
  return (
    <div className={`bg-dark-800 border ${t.ring} rounded-2xl p-5 flex flex-col`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`px-2 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider border ${t.badge}`}>{badge}</span>
      </div>
      <h4 className="text-base font-poppins font-bold text-white">{title}</h4>
      <p className="text-xl font-bold text-white mt-2 tabular-nums">{price}</p>
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">{priceNote}</p>
      <p className="text-xs text-gray-400 mb-3 leading-relaxed">{description}</p>
      <ul className="space-y-1.5 flex-1 mb-4">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2 text-[12px] text-gray-300">
            <i className={`ri-check-line ${t.check} text-sm mt-0.5 shrink-0`} />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <Link to={ctaHref} className={`text-center px-3 py-2 rounded-lg text-xs font-medium ${t.btn}`}>
        {cta}
      </Link>
    </div>
  );
}
