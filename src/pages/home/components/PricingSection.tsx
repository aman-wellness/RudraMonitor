import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';

// Public-facing pricing display. Prices mirror the v2 SKUs seeded in
// supabase/migrations/0069_new_plan_structure.sql — keep these in sync if
// you change the migration. Phase 8 (admin pricing editor) will move this
// to a DB-driven RPC; for now we hardcode so the landing page can render
// without any DB round-trip and works for anonymous visitors.

type Currency = 'INR' | 'USD';
type Cycle = 'monthly' | 'yearly';

interface PlanCard {
  code: string;
  name: string;
  blurb: string;
  unitPrice: { inr: number; usd: number };
  features: string[];
  notIncluded?: string[];
  ctaLabel: string;
  ctaHref: string;
  highlighted?: boolean;
  enterprise?: boolean;
  capNote?: string;
}

interface PlanFamily {
  starter: PlanCard;
  professional: PlanCard;
  emStandalone: PlanCard;
  enterprise: PlanCard;
}

const PLANS: Record<Cycle, PlanFamily> = {
  monthly: {
    starter: {
      code: 'starter-m',
      name: 'Starter',
      blurb: 'Basic activity monitoring for small teams just getting started.',
      unitPrice: { inr: 299, usd: 4 },
      features: [
        'Application & browser tracking',
        'Idle / active time detection',
        'Productivity rules & reports',
        'Daily, weekly summaries',
        'Up to unlimited seats',
      ],
      notIncluded: ['Screenshots', 'Video recording', 'Live monitoring', 'Remote desktop', 'DLP', 'Employee Management'],
      ctaLabel: 'Start Starter',
      ctaHref: '/signup?plan=starter-m',
    },
    professional: {
      code: 'pro-m',
      name: 'Professional',
      blurb: 'Full visibility — screenshots, videos, live screen + remote desktop, DLP.',
      unitPrice: { inr: 899, usd: 12 },
      features: [
        'Everything in Starter',
        'Periodic screenshots',
        'Video clip recording',
        'Live WebRTC monitoring',
        'Remote desktop control',
        'AI-powered DLP (USB + email + clipboard)',
      ],
      notIncluded: ['Employee Management (available as add-on)'],
      ctaLabel: 'Start Professional',
      ctaHref: '/signup?plan=pro-m',
      highlighted: true,
    },
    emStandalone: {
      code: 'em-m',
      name: 'Employee Management',
      blurb: 'EM-only — no monitoring. Full IT lifecycle from joining to offboarding.',
      unitPrice: { inr: 499, usd: 7 },
      features: [
        'M365 + Google Workspace sync',
        'Groups, teams, managers',
        'Credentials vault + self-service',
        'IT hardware inventory',
        '4-stage offboarding pipeline',
      ],
      notIncluded: ['Activity monitoring', 'Screenshots', 'Videos', 'Live / Remote', 'DLP'],
      ctaLabel: 'Start EM',
      ctaHref: '/signup?plan=em-m',
      capNote: 'Up to 2,000 users. Above that, switch to Enterprise.',
    },
    enterprise: {
      code: 'enterprise',
      name: 'Enterprise',
      blurb: 'Everything, unlimited. Custom SLA, dedicated CSM, on-prem deployment optional.',
      unitPrice: { inr: 0, usd: 0 },
      features: [
        'All Professional + EM features',
        'Unlimited users',
        'Dedicated success manager',
        'Custom SLA + uptime guarantee',
        'SSO + custom data retention',
        'On-prem deployment available',
      ],
      ctaLabel: 'Contact Sales',
      ctaHref: '/#contact',
      enterprise: true,
    },
  },
  yearly: {
    starter: {
      code: 'starter-y',
      name: 'Starter',
      blurb: 'Basic activity monitoring for small teams just getting started.',
      unitPrice: { inr: 2999, usd: 40 },
      features: [
        'Application & browser tracking',
        'Idle / active time detection',
        'Productivity rules & reports',
        'Daily, weekly summaries',
        'Up to unlimited seats',
      ],
      notIncluded: ['Screenshots', 'Video recording', 'Live monitoring', 'Remote desktop', 'DLP', 'Employee Management'],
      ctaLabel: 'Start Starter',
      ctaHref: '/signup?plan=starter-y',
    },
    professional: {
      code: 'pro-y',
      name: 'Professional',
      blurb: 'Full visibility — screenshots, videos, live screen + remote desktop, DLP.',
      unitPrice: { inr: 8999, usd: 120 },
      features: [
        'Everything in Starter',
        'Periodic screenshots',
        'Video clip recording',
        'Live WebRTC monitoring',
        'Remote desktop control',
        'AI-powered DLP (USB + email + clipboard)',
      ],
      notIncluded: ['Employee Management (available as add-on)'],
      ctaLabel: 'Start Professional',
      ctaHref: '/signup?plan=pro-y',
      highlighted: true,
    },
    emStandalone: {
      code: 'em-y',
      name: 'Employee Management',
      blurb: 'EM-only — no monitoring. Full IT lifecycle from joining to offboarding.',
      unitPrice: { inr: 4999, usd: 67 },
      features: [
        'M365 + Google Workspace sync',
        'Groups, teams, managers',
        'Credentials vault + self-service',
        'IT hardware inventory',
        '4-stage offboarding pipeline',
      ],
      notIncluded: ['Activity monitoring', 'Screenshots', 'Videos', 'Live / Remote', 'DLP'],
      ctaLabel: 'Start EM',
      ctaHref: '/signup?plan=em-y',
      capNote: 'Up to 2,000 users. Above that, switch to Enterprise.',
    },
    enterprise: {
      code: 'enterprise',
      name: 'Enterprise',
      blurb: 'Everything, unlimited. Custom SLA, dedicated CSM, on-prem deployment optional.',
      unitPrice: { inr: 0, usd: 0 },
      features: [
        'All Professional + EM features',
        'Unlimited users',
        'Dedicated success manager',
        'Custom SLA + uptime guarantee',
        'SSO + custom data retention',
        'On-prem deployment available',
      ],
      ctaLabel: 'Contact Sales',
      ctaHref: '/#contact',
      enterprise: true,
    },
  },
};

const ADDONS = {
  monthly: {
    dlp: { name: 'DLP Add-on', inr: 199, usd: 3, code: 'dlp-addon-m' },
    em:  { name: 'Employee Management Add-on', inr: 499, usd: 7, code: 'em-addon-m' },
  },
  yearly: {
    dlp: { name: 'DLP Add-on', inr: 1999, usd: 27, code: 'dlp-addon-y' },
    em:  { name: 'Employee Management Add-on', inr: 4999, usd: 67, code: 'em-addon-y' },
  },
};

export default function PricingSection() {
  const [currency, setCurrency] = useState<Currency>('INR');
  const [cycle, setCycle] = useState<Cycle>('yearly');
  const [seats, setSeats] = useState(10);

  const plans = PLANS[cycle];

  const fmt = (inr: number, usd: number) =>
    currency === 'INR'
      ? `₹${inr.toLocaleString('en-IN')}`
      : `$${usd.toLocaleString('en-US')}`;

  const total = (p: PlanCard) =>
    p.enterprise ? null : fmt(p.unitPrice.inr * seats, p.unitPrice.usd * seats);

  const yearlySavingsPct = useMemo(() => {
    // Saved % comparing yearly per-seat-per-year vs 12× monthly per-seat-per-year.
    // Use Starter as the anchor — every tier saves roughly the same.
    const monthly = PLANS.monthly.starter.unitPrice.inr * 12;
    const yearly = PLANS.yearly.starter.unitPrice.inr;
    return Math.round(((monthly - yearly) / monthly) * 100);
  }, []);

  return (
    <section id="pricing" className="relative bg-dark-900 py-16 md:py-24">
      <div className="w-full px-4 md:px-8 lg:px-12 max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-10 md:mb-14">
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-4">
            <i className="ri-price-tag-3-line text-emerald-400 text-sm" />
            <span className="text-xs md:text-sm text-emerald-400 font-medium">Pricing</span>
          </div>
          <h2 className="text-2xl md:text-3xl lg:text-4xl font-poppins font-bold text-white mb-4">
            Simple per-seat pricing. Pay for what you use.
          </h2>
          <p className="text-sm md:text-base text-gray-400 max-w-2xl mx-auto mb-6">
            Choose your tier, pick the number of seats, get a license for every device.
            14-day free trial, no credit card.
          </p>

          {/* Currency + Billing-cycle toggles */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <div className="inline-flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-full p-1">
              <button
                onClick={() => setCurrency('INR')}
                className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
                  currency === 'INR' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                ₹ INR
              </button>
              <button
                onClick={() => setCurrency('USD')}
                className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
                  currency === 'USD' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                $ USD
              </button>
            </div>

            <div className="inline-flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-full p-1">
              <button
                onClick={() => setCycle('monthly')}
                className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
                  cycle === 'monthly' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                Monthly
              </button>
              <button
                onClick={() => setCycle('yearly')}
                className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
                  cycle === 'yearly' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >
                Yearly
                <span className="ml-1 text-[10px] bg-white/20 px-1.5 py-0.5 rounded">save {yearlySavingsPct}%</span>
              </button>
            </div>
          </div>

          {/* Seat picker */}
          <div className="mt-6 inline-flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-xl px-5 py-3">
            <i className="ri-team-line text-gray-400" />
            <label htmlFor="seats" className="text-sm text-gray-300">Seats:</label>
            <button
              type="button"
              onClick={() => setSeats((s) => Math.max(1, s - 5))}
              className="w-7 h-7 rounded-md bg-dark-700 hover:bg-dark-600 text-white text-sm"
              aria-label="Decrease seats"
            >−</button>
            <input
              id="seats"
              type="number"
              min={1}
              max={10000}
              value={seats}
              onChange={(e) => setSeats(Math.max(1, Math.min(10000, parseInt(e.target.value || '1', 10))))}
              className="w-16 text-center bg-dark-900 border border-dark-700 rounded-md py-1 text-sm text-white focus:outline-none focus:border-emerald-500"
            />
            <button
              type="button"
              onClick={() => setSeats((s) => Math.min(10000, s + 5))}
              className="w-7 h-7 rounded-md bg-dark-700 hover:bg-dark-600 text-white text-sm"
              aria-label="Increase seats"
            >+</button>
          </div>
        </div>

        {/* Plan cards: 4 across on desktop, stacked on mobile */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {[plans.starter, plans.professional, plans.emStandalone, plans.enterprise].map((plan) => (
            <PlanCardView
              key={plan.code}
              plan={plan}
              seats={seats}
              cycle={cycle}
              currency={currency}
              unitPriceFmt={fmt(plan.unitPrice.inr, plan.unitPrice.usd)}
              totalFmt={total(plan)}
            />
          ))}
        </div>

        {/* Add-ons row */}
        <div className="mt-12">
          <div className="text-center mb-5">
            <h3 className="text-lg md:text-xl font-poppins font-semibold text-white">Add-ons</h3>
            <p className="text-xs text-gray-500 mt-1">
              Stack onto any base plan. Same {cycle === 'yearly' ? 'yearly' : 'monthly'} billing cycle. Per-seat.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl mx-auto">
            <AddonCard
              tint="cyan"
              title={ADDONS[cycle].dlp.name}
              unitPrice={fmt(ADDONS[cycle].dlp.inr, ADDONS[cycle].dlp.usd)}
              total={fmt(ADDONS[cycle].dlp.inr * seats, ADDONS[cycle].dlp.usd * seats)}
              cycle={cycle}
              description="Data Loss Prevention. AI-classified USB transfers, email attachments, and clipboard alerts in real time. Useful add-on to Starter."
            />
            <AddonCard
              tint="violet"
              title={ADDONS[cycle].em.name}
              unitPrice={fmt(ADDONS[cycle].em.inr, ADDONS[cycle].em.usd)}
              total={fmt(ADDONS[cycle].em.inr * seats, ADDONS[cycle].em.usd * seats)}
              cycle={cycle}
              description="Layer the Employee Management suite onto Professional. M365 / Google sync, credentials vault, hardware, offboarding."
            />
          </div>
        </div>

        {/* Fine print */}
        <p className="text-center text-[11px] text-gray-500 mt-10 max-w-3xl mx-auto leading-relaxed">
          Indian customers billed in INR (+ 18% GST). International customers billed in USD via Razorpay.
          14-day free trial on all plans, no credit card required. Cancel anytime from the admin portal.
        </p>
      </div>
    </section>
  );
}

function PlanCardView({
  plan, seats, cycle, currency, unitPriceFmt, totalFmt,
}: {
  plan: PlanCard;
  seats: number;
  cycle: Cycle;
  currency: Currency;
  unitPriceFmt: string;
  totalFmt: string | null;
}) {
  const cycleLabel = cycle === 'yearly' ? 'year' : 'month';
  // Build CTA href with seat count + currency hint for the signup flow to consume.
  const href = plan.enterprise
    ? plan.ctaHref
    : `${plan.ctaHref}&seats=${seats}&currency=${currency.toLowerCase()}`;

  return (
    <div
      className={`relative bg-dark-800 border rounded-2xl p-6 flex flex-col transition-all ${
        plan.highlighted
          ? 'border-emerald-500/60 shadow-xl shadow-emerald-500/10'
          : plan.enterprise
            ? 'border-violet-500/40'
            : 'border-dark-700 hover:border-emerald-500/30'
      }`}
    >
      {plan.highlighted && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="bg-emerald-500 text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full">
            Most Popular
          </span>
        </div>
      )}
      {plan.enterprise && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="bg-violet-500 text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full">
            Contact Sales
          </span>
        </div>
      )}

      <div className="text-center mb-4 pt-2">
        <h3 className="text-lg font-poppins font-bold text-white mb-1">{plan.name}</h3>
        <p className="text-xs text-gray-500 leading-relaxed min-h-[2.5em]">{plan.blurb}</p>
      </div>

      <div className="text-center mb-5">
        {plan.enterprise ? (
          <span className="text-2xl font-bold text-white">Custom</span>
        ) : (
          <>
            <div>
              <span className="text-3xl font-bold text-white tabular-nums">{unitPriceFmt}</span>
              <span className="text-xs text-gray-500 ml-1">/ seat / {cycleLabel}</span>
            </div>
            <p className="text-[11px] text-emerald-400 mt-1.5 font-medium">
              {seats} seat{seats === 1 ? '' : 's'} = {totalFmt} / {cycleLabel}
            </p>
            {plan.capNote && (
              <p className="text-[10px] text-amber-300/80 mt-1">{plan.capNote}</p>
            )}
          </>
        )}
      </div>

      <ul className="space-y-2 mb-4 flex-1">
        {plan.features.map((f, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px] text-gray-300">
            <i className="ri-check-line text-emerald-400 text-sm mt-0.5 shrink-0" />
            <span className="leading-relaxed">{f}</span>
          </li>
        ))}
        {plan.notIncluded?.map((f, i) => (
          <li key={`nx-${i}`} className="flex items-start gap-2 text-[12.5px] text-gray-600">
            <i className="ri-close-line text-gray-600 text-sm mt-0.5 shrink-0" />
            <span className="leading-relaxed line-through">{f}</span>
          </li>
        ))}
      </ul>

      <Link
        to={href}
        className={`block text-center w-full py-2.5 rounded-lg font-medium text-sm transition-all ${
          plan.highlighted
            ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'
            : plan.enterprise
              ? 'bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/30 text-violet-200'
              : 'border border-dark-600 hover:border-emerald-500 text-white hover:text-emerald-400'
        }`}
      >
        {plan.ctaLabel}
      </Link>
    </div>
  );
}

function AddonCard({
  tint, title, unitPrice, total, cycle, description,
}: {
  tint: 'cyan' | 'violet';
  title: string;
  unitPrice: string;
  total: string;
  cycle: Cycle;
  description: string;
}) {
  const t = {
    cyan:   { ring: 'border-cyan-500/25',   accent: 'text-cyan-300' },
    violet: { ring: 'border-violet-500/25', accent: 'text-violet-300' },
  }[tint];
  return (
    <div className={`bg-dark-800 border ${t.ring} rounded-2xl p-5 flex flex-col gap-2`}>
      <div className="flex items-baseline justify-between">
        <h4 className={`text-base font-semibold ${t.accent}`}>{title}</h4>
        <div className="text-right">
          <p className="text-lg font-bold text-white">{unitPrice}</p>
          <p className="text-[10px] text-gray-500">/ seat / {cycle === 'yearly' ? 'year' : 'month'}</p>
        </div>
      </div>
      <p className="text-xs text-gray-400 leading-relaxed">{description}</p>
      <p className="text-[11px] text-gray-500 mt-1">Total at current seats: <span className="text-white font-medium">{total}</span></p>
    </div>
  );
}
