import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

// Public-facing pricing display. Prices mirror the v2 SKUs seeded in
// supabase/migrations/0069_new_plan_structure.sql — keep these in sync if
// you change the migration. Phase 8 (admin pricing editor) will move this
// to a DB-driven RPC; for now we hardcode so the landing page can render
// without any DB round-trip and works for anonymous visitors.

type Currency = 'INR' | 'USD';
type Cycle = 'monthly' | 'yearly';
type AddonId = 'dlp' | 'em';

interface PlanCard {
  code: { monthly: string; yearly: string };
  name: string;
  blurb: string;
  unit: { monthly: { inr: number; usd: number }; yearly: { inr: number; usd: number } };
  features: string[];
  notIncluded?: string[];
  available_addons: AddonId[];
  ctaLabel: string;
  ctaHref: string;
  highlighted?: boolean;
  enterprise?: boolean;
  capNote?: string;
}

const STARTER: PlanCard = {
  code: { monthly: 'starter-m', yearly: 'starter-y' },
  name: 'Starter',
  blurb: 'Basic activity monitoring for small teams.',
  unit: { monthly: { inr: 299, usd: 4 }, yearly: { inr: 2999, usd: 40 } },
  features: [
    'Application & browser tracking',
    'Idle / active time detection',
    'Productivity rules & reports',
    'Daily, weekly summaries',
    'Unlimited seats',
  ],
  notIncluded: ['Screenshots', 'Video recording', 'Live monitoring', 'Remote desktop'],
  available_addons: ['dlp', 'em'],
  ctaLabel: 'Start Starter',
  ctaHref: '/signup',
};

const PROFESSIONAL: PlanCard = {
  code: { monthly: 'pro-m', yearly: 'pro-y' },
  name: 'Professional',
  blurb: 'Full visibility — screenshots, videos, live + remote, DLP.',
  unit: { monthly: { inr: 899, usd: 12 }, yearly: { inr: 8999, usd: 120 } },
  features: [
    'Everything in Starter',
    'Periodic screenshots',
    'Video clip recording',
    'Live WebRTC monitoring',
    'Remote desktop control',
    'AI-powered DLP',
  ],
  notIncluded: ['Employee Management (available as add-on)'],
  available_addons: ['em'],
  ctaLabel: 'Start Professional',
  ctaHref: '/signup',
  highlighted: true,
};

const EM_STANDALONE: PlanCard = {
  code: { monthly: 'em-m', yearly: 'em-y' },
  name: 'Employee Management',
  blurb: 'EM-only — IT lifecycle. No monitoring agents.',
  unit: { monthly: { inr: 499, usd: 7 }, yearly: { inr: 4999, usd: 67 } },
  features: [
    'M365 + Google Workspace sync',
    'Groups, teams, managers',
    'Credentials vault + self-service',
    'IT hardware inventory',
    '4-stage offboarding pipeline',
  ],
  notIncluded: ['Activity monitoring', 'Screenshots', 'DLP'],
  available_addons: [],
  ctaLabel: 'Start EM',
  ctaHref: '/signup',
  capNote: 'Up to 2,000 users. Above that, switch to Enterprise.',
};

const ENTERPRISE: PlanCard = {
  code: { monthly: 'enterprise', yearly: 'enterprise' },
  name: 'Enterprise',
  blurb: 'Everything, unlimited. Custom SLA + dedicated CSM.',
  unit: { monthly: { inr: 0, usd: 0 }, yearly: { inr: 0, usd: 0 } },
  features: [
    'All Professional + EM features',
    'Unlimited users',
    'Dedicated success manager',
    'Custom SLA + uptime guarantee',
    'SSO + custom data retention',
    'On-prem deployment available',
  ],
  available_addons: [],
  ctaLabel: 'Contact Sales',
  ctaHref: '/#contact',
  enterprise: true,
};

const ADDON_META: Record<AddonId, {
  code: { monthly: string; yearly: string };
  label: string;
  icon: string;
  short: string;
  unit: { monthly: { inr: number; usd: number }; yearly: { inr: number; usd: number } };
  features: string[];
}> = {
  dlp: {
    code: { monthly: 'dlp-addon-m', yearly: 'dlp-addon-y' },
    label: 'DLP Add-on',
    icon:  'ri-shield-keyhole-line',
    short: 'Data Loss Prevention — AI-classified USB transfers, email attachments, clipboard alerts.',
    unit: { monthly: { inr: 199, usd: 3 }, yearly: { inr: 1999, usd: 27 } },
    features: [
      'USB file copy detection',
      'Personal mail attachment monitoring',
      'Clipboard exfiltration alerts',
      'AI severity classification',
      'Authorized domains whitelist',
      'Severity-tiered email alerts',
    ],
  },
  em: {
    code: { monthly: 'em-addon-m', yearly: 'em-addon-y' },
    label: 'Employee Management Add-on',
    icon:  'ri-team-line',
    short: 'Layer the EM suite onto your plan — provisioning, credentials, hardware, offboarding.',
    unit: { monthly: { inr: 499, usd: 7 }, yearly: { inr: 4999, usd: 67 } },
    features: [
      'M365 + Google Workspace sync',
      'Groups, teams, managers',
      'Credentials vault + request flow',
      'IT hardware inventory',
      '4-stage offboarding pipeline',
      'Per-platform invoice tracking',
    ],
  },
};

const ALL_PLANS: PlanCard[] = [STARTER, PROFESSIONAL, EM_STANDALONE, ENTERPRISE];

export default function PricingSection() {
  const [currency, setCurrency] = useState<Currency>('INR');
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const [seats, setSeats] = useState(10);
  // Per-plan add-on selections. Keyed by plan name; value is the set of
  // addon ids currently toggled on. Lets each customer mix the add-ons
  // they want without affecting the other plan cards.
  const [selectedAddons, setSelectedAddons] = useState<Record<string, Set<AddonId>>>({});

  const toggleAddon = (planName: string, addon: AddonId) => {
    setSelectedAddons((prev) => {
      const cur = new Set(prev[planName] ?? []);
      if (cur.has(addon)) cur.delete(addon); else cur.add(addon);
      return { ...prev, [planName]: cur };
    });
  };

  const fmt = (inr: number, usd: number) =>
    currency === 'INR' ? `₹${inr.toLocaleString('en-IN')}` : `$${usd.toLocaleString('en-US')}`;

  const yearlySavingsPct = useMemo(() => {
    const monthly = STARTER.unit.monthly.inr * 12;
    const yearly = STARTER.unit.yearly.inr;
    return Math.round(((monthly - yearly) / monthly) * 100);
  }, []);

  return (
    <section id="pricing" className="relative bg-dark-900 py-16 md:py-24 overflow-hidden">
      {/* Background flourish — subtle glow for the 3D feel */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/4 w-96 h-96 bg-emerald-500/5 blur-3xl rounded-full" />
        <div className="absolute bottom-1/3 right-1/4 w-96 h-96 bg-violet-500/5 blur-3xl rounded-full" />
      </div>

      <div className="relative w-full px-4 md:px-8 lg:px-12 max-w-7xl mx-auto">
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
            Pick a tier, pick your seat count, optionally stack add-ons. Every plan ships with
            a 14-day free trial — no credit card.
          </p>

          {/* Currency + Billing-cycle toggles */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <div className="inline-flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-full p-1">
              <button onClick={() => setCurrency('INR')} className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
                currency === 'INR' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
              }`}>₹ INR</button>
              <button onClick={() => setCurrency('USD')} className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
                currency === 'USD' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
              }`}>$ USD</button>
            </div>

            <div className="inline-flex items-center gap-1 bg-dark-800 border border-dark-700 rounded-full p-1">
              <button onClick={() => setCycle('monthly')} className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
                cycle === 'monthly' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
              }`}>Monthly</button>
              <button onClick={() => setCycle('yearly')} className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
                cycle === 'yearly' ? 'bg-emerald-500 text-white' : 'text-gray-400 hover:text-white'
              }`}>
                Yearly
                <span className="ml-1 text-[10px] bg-white/20 px-1.5 py-0.5 rounded">save {yearlySavingsPct}%</span>
              </button>
            </div>
          </div>

          {/* Seat picker */}
          <div className="mt-6 inline-flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-xl px-5 py-3 shadow-lg shadow-dark-950">
            <i className="ri-team-line text-gray-400" />
            <label htmlFor="seats" className="text-sm text-gray-300">Seats:</label>
            <button type="button" onClick={() => setSeats((s) => Math.max(1, s - 5))} className="w-7 h-7 rounded-md bg-dark-700 hover:bg-dark-600 text-white text-sm" aria-label="Decrease seats">−</button>
            <input id="seats" type="number" min={1} max={10000} value={seats}
              onChange={(e) => setSeats(Math.max(1, Math.min(10000, parseInt(e.target.value || '1', 10))))}
              className="w-16 text-center bg-dark-900 border border-dark-700 rounded-md py-1 text-sm text-white focus:outline-none focus:border-emerald-500" />
            <button type="button" onClick={() => setSeats((s) => Math.min(10000, s + 5))} className="w-7 h-7 rounded-md bg-dark-700 hover:bg-dark-600 text-white text-sm" aria-label="Increase seats">+</button>
          </div>
        </div>

        {/* Plan cards: 4 across on desktop, stacked on mobile */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {ALL_PLANS.map((plan) => (
            <PlanCardView
              key={plan.name}
              plan={plan}
              cycle={cycle}
              currency={currency}
              seats={seats}
              fmt={fmt}
              selectedAddons={selectedAddons[plan.name] ?? new Set()}
              onToggleAddon={(addon) => toggleAddon(plan.name, addon)}
            />
          ))}
        </div>

        {/* Fine print */}
        <p className="text-center text-[11px] text-gray-500 mt-12 max-w-3xl mx-auto leading-relaxed">
          Indian customers billed in INR (+ 18% GST). International customers billed in USD via Razorpay.
          14-day free trial on all plans, no credit card required. Cancel anytime from the admin portal.
        </p>
      </div>
    </section>
  );
}

function PlanCardView({
  plan, cycle, currency, seats, fmt, selectedAddons, onToggleAddon,
}: {
  plan: PlanCard;
  cycle: Cycle;
  currency: Currency;
  seats: number;
  fmt: (inr: number, usd: number) => string;
  selectedAddons: Set<AddonId>;
  onToggleAddon: (a: AddonId) => void;
}) {
  const unit = plan.unit[cycle];
  const cycleWord = cycle === 'yearly' ? 'year' : 'month';

  // Compose the running total including any add-ons the user has toggled on.
  const addonsTotal = Array.from(selectedAddons).reduce(
    (acc, id) => {
      const a = ADDON_META[id];
      return { inr: acc.inr + a.unit[cycle].inr, usd: acc.usd + a.unit[cycle].usd };
    },
    { inr: 0, usd: 0 },
  );
  const planTotal = { inr: unit.inr * seats, usd: unit.usd * seats };
  const grandTotal = {
    inr: planTotal.inr + addonsTotal.inr * seats,
    usd: planTotal.usd + addonsTotal.usd * seats,
  };

  // Build a CTA URL that pre-populates the signup with the selected plan,
  // billing cycle, seat count + selected add-ons. Phase 7 (Razorpay
  // checkout) will consume these.
  const href = plan.enterprise
    ? plan.ctaHref
    : `${plan.ctaHref}?plan=${plan.code[cycle]}&seats=${seats}&currency=${currency.toLowerCase()}${
        selectedAddons.size > 0
          ? `&addons=${Array.from(selectedAddons).map((id) => ADDON_META[id].code[cycle]).join(',')}`
          : ''
      }`;

  return (
    <div
      className={`group relative bg-gradient-to-br rounded-2xl p-[1px] transition-all duration-300 hover:-translate-y-1 ${
        plan.highlighted
          ? 'from-emerald-500/60 via-emerald-400/30 to-transparent shadow-2xl shadow-emerald-500/15'
          : plan.enterprise
            ? 'from-violet-500/50 via-violet-400/25 to-transparent shadow-2xl shadow-violet-500/15'
            : 'from-dark-700 to-dark-800 hover:from-emerald-500/30 hover:to-transparent'
      }`}
    >
      <div className="relative bg-dark-800 rounded-2xl p-6 h-full flex flex-col">
        {plan.highlighted && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-emerald-500 text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full shadow-lg shadow-emerald-500/40">
              Most Popular
            </span>
          </div>
        )}
        {plan.enterprise && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-violet-500 text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full shadow-lg shadow-violet-500/40">
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
                <span className="text-3xl font-bold text-white tabular-nums">{fmt(unit.inr, unit.usd)}</span>
                <span className="text-xs text-gray-500 ml-1">/ seat / {cycleWord}</span>
              </div>
              <p className="text-[11px] text-emerald-400 mt-1.5 font-medium">
                {seats} seat{seats === 1 ? '' : 's'} = {fmt(planTotal.inr, planTotal.usd)} / {cycleWord}
              </p>
              {plan.capNote && (
                <p className="text-[10px] text-amber-300/80 mt-1">{plan.capNote}</p>
              )}
            </>
          )}
        </div>

        {/* Features */}
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

        {/* Inline add-ons for this plan */}
        {plan.available_addons.length > 0 && (
          <div className="mb-4 space-y-2 border-t border-dark-700 pt-4">
            <p className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-2">Optional add-ons</p>
            {plan.available_addons.map((id) => {
              const a = ADDON_META[id];
              const active = selectedAddons.has(id);
              return (
                <AddonToggle
                  key={id}
                  active={active}
                  meta={a}
                  cycle={cycle}
                  fmt={fmt}
                  onToggle={() => onToggleAddon(id)}
                />
              );
            })}
          </div>
        )}

        {/* Total when add-ons selected */}
        {!plan.enterprise && selectedAddons.size > 0 && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-center">
            <p className="text-[10px] uppercase tracking-wider text-emerald-400 font-medium">Total with add-ons</p>
            <p className="text-base font-bold text-white">
              {fmt(grandTotal.inr, grandTotal.usd)} / {cycleWord}
            </p>
          </div>
        )}

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
    </div>
  );
}

function AddonToggle({
  active, meta, cycle, fmt, onToggle,
}: {
  active: boolean;
  meta: typeof ADDON_META[AddonId];
  cycle: Cycle;
  fmt: (inr: number, usd: number) => string;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const unit = meta.unit[cycle];
  return (
    <div className={`rounded-lg border transition-all ${
      active ? 'bg-emerald-500/8 border-emerald-500/40' : 'bg-dark-900/40 border-dark-700 hover:border-dark-600'
    }`}>
      <div className="flex items-center justify-between gap-2 p-2.5">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 flex-1 text-left min-w-0"
          aria-expanded={expanded}
        >
          <i className={`${meta.icon} text-sm ${active ? 'text-emerald-400' : 'text-gray-400'} shrink-0`} />
          <div className="min-w-0">
            <p className={`text-xs font-medium truncate ${active ? 'text-emerald-200' : 'text-gray-200'}`}>
              {meta.label}
            </p>
            <p className="text-[10px] text-gray-500">
              +{fmt(unit.inr, unit.usd)} / seat / {cycle === 'yearly' ? 'year' : 'month'}
            </p>
          </div>
          <i className={`ri-arrow-${expanded ? 'up' : 'down'}-s-line text-gray-500 shrink-0`} />
        </button>
        <button
          type="button"
          onClick={onToggle}
          className={`shrink-0 w-9 h-5 rounded-full relative transition-colors ${
            active ? 'bg-emerald-500' : 'bg-dark-700'
          }`}
          aria-pressed={active}
          aria-label={active ? `Remove ${meta.label}` : `Add ${meta.label}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
            active ? 'left-4' : 'left-0.5'
          }`} />
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 border-t border-dark-700 mt-1 pt-2.5">
          <p className="text-[11px] text-gray-400 mb-2 leading-relaxed">{meta.short}</p>
          <ul className="space-y-1">
            {meta.features.map((f) => (
              <li key={f} className="flex items-start gap-1.5 text-[11px] text-gray-300">
                <i className="ri-check-line text-emerald-400 text-xs mt-0.5 shrink-0" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
          {!active && (
            <button
              type="button"
              onClick={onToggle}
              className="mt-2.5 w-full py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[11px] font-medium"
            >
              + Add this to my plan
            </button>
          )}
        </div>
      )}
    </div>
  );
}
