// Subscription overview — owner-only. Mirrors the landing-page pricing grid
// so the in-app upgrade flow speaks the same UI language as the marketing
// site. Lists all four base tiers + inline DLP / EM add-ons exactly the way
// PricingSection.tsx renders them, with the customer's current plan
// highlighted.
//
// Live Razorpay checkout for the new SKUs lands in Phase 7 — until then the
// "Subscribe" CTAs route to the existing checkout flow.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import { useFeatures } from '@/lib/useFeatures';
import { useAuth } from '@/context/AuthContext';

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
  highlighted?: boolean;
  enterprise?: boolean;
  capNote?: string;
}

// Keep these in sync with home/components/PricingSection.tsx + the
// v2 plan rows seeded in supabase/migrations/0069_new_plan_structure.sql.
const STARTER: PlanCard = {
  code: { monthly: 'starter-m', yearly: 'starter-y' },
  name: 'Starter',
  blurb: 'Basic activity monitoring for small teams.',
  unit: { monthly: { inr: 299, usd: 4 }, yearly: { inr: 2999, usd: 40 } },
  features: [
    'Application & browser tracking',
    'Idle / active time detection',
    'Productivity rules & reports',
  ],
  notIncluded: ['Screenshots', 'Videos', 'Live', 'Remote', 'DLP', 'EM'],
  available_addons: ['dlp', 'em'],
  ctaLabel: 'Switch to Starter',
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
    'Live + Remote desktop',
    'AI-powered DLP',
  ],
  notIncluded: ['Employee Management (add-on available)'],
  available_addons: ['em'],
  ctaLabel: 'Switch to Professional',
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
    'Credentials vault',
    'IT hardware inventory',
    'Offboarding pipeline',
  ],
  notIncluded: ['Activity monitoring', 'DLP'],
  available_addons: [],
  ctaLabel: 'Switch to EM-only',
  capNote: 'Up to 2,000 users.',
};
const ENTERPRISE: PlanCard = {
  code: { monthly: 'enterprise', yearly: 'enterprise' },
  name: 'Enterprise',
  blurb: 'Everything, unlimited. Custom SLA + dedicated CSM.',
  unit: { monthly: { inr: 0, usd: 0 }, yearly: { inr: 0, usd: 0 } },
  features: [
    'All Professional + EM features',
    'Unlimited users',
    'Custom SLA + SSO + on-prem option',
  ],
  available_addons: [],
  ctaLabel: 'Contact Sales',
  enterprise: true,
};

const ALL_PLANS = [STARTER, PROFESSIONAL, EM_STANDALONE, ENTERPRISE];

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
    short: 'Data Loss Prevention — USB transfers, email attachments, clipboard alerts.',
    unit: { monthly: { inr: 199, usd: 3 }, yearly: { inr: 1999, usd: 27 } },
    features: [
      'USB file copy detection',
      'Personal mail attachment monitor',
      'Clipboard exfiltration alerts',
      'AI severity classification',
      'Authorized-domains whitelist',
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
      'Offboarding pipeline',
    ],
  },
};

export default function SubscriptionPage() {
  const { organization } = useAuth();
  const features = useFeatures();

  // country_code isn't on the typed Organization shape (it's a soft column
  // added later); read it through a cast so TS doesn't complain.
  const country = String((organization as { country_code?: string } | null)?.country_code ?? '').toUpperCase();
  const showInr = country === 'IN';
  const [currency, setCurrency] = useState<Currency>(showInr ? 'INR' : 'USD');
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const [seats, setSeats] = useState(10);
  const [selectedAddons, setSelectedAddons] = useState<Record<string, Set<AddonId>>>({});

  const fmt = (inr: number, usd: number) =>
    currency === 'INR' ? `₹${inr.toLocaleString('en-IN')}` : `$${usd.toLocaleString('en-US')}`;

  const yearlySavingsPct = useMemo(() => {
    const monthly = STARTER.unit.monthly.inr * 12;
    const yearly = STARTER.unit.yearly.inr;
    return Math.round(((monthly - yearly) / monthly) * 100);
  }, []);

  const toggleAddon = (planName: string, addon: AddonId) => {
    setSelectedAddons((prev) => {
      const cur = new Set(prev[planName] ?? []);
      if (cur.has(addon)) cur.delete(addon); else cur.add(addon);
      return { ...prev, [planName]: cur };
    });
  };

  const trialDaysLeft = (() => {
    if (features.subscription_status !== 'trial' || !features.trial_ends_at) return null;
    const diff = new Date(features.trial_ends_at).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86_400_000));
  })();

  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl md:text-3xl font-poppins font-semibold text-white mb-1">Subscription</h1>
          <p className="text-sm text-gray-400">Manage your plan and add-ons.</p>
        </header>

        {/* Current status banner */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wider">Current plan</p>
              <p className="text-xl text-white font-semibold mt-1">{organization?.name ?? '—'}</p>
              {features.subscription_status === 'trial' && trialDaysLeft !== null && (
                <p className="text-sm text-amber-300 mt-1">
                  {trialDaysLeft > 0
                    ? `${trialDaysLeft} days left in trial — all modules active until ${new Date(features.trial_ends_at).toLocaleDateString()}.`
                    : `Trial ended ${new Date(features.trial_ends_at).toLocaleDateString()}.`}
                </p>
              )}
            </div>
            <StatusPill status={features.subscription_status} />
          </div>
        </div>

        {/* Toggles — same shape as the landing page so the UX rhymes */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-8">
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
          <div className="inline-flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-xl px-4 py-2">
            <i className="ri-team-line text-gray-400 text-sm" />
            <label htmlFor="seats" className="text-xs text-gray-300">Seats:</label>
            <button type="button" onClick={() => setSeats((s) => Math.max(1, s - 5))} className="w-6 h-6 rounded-md bg-dark-700 hover:bg-dark-600 text-white text-xs">−</button>
            <input id="seats" type="number" min={1} max={10000} value={seats}
              onChange={(e) => setSeats(Math.max(1, Math.min(10000, parseInt(e.target.value || '1', 10))))}
              className="w-14 text-center bg-dark-900 border border-dark-700 rounded-md py-1 text-xs text-white focus:outline-none focus:border-emerald-500" />
            <button type="button" onClick={() => setSeats((s) => Math.min(10000, s + 5))} className="w-6 h-6 rounded-md bg-dark-700 hover:bg-dark-600 text-white text-xs">+</button>
          </div>
        </div>

        {/* Plan grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
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

        <p className="mt-8 text-center text-[11px] text-gray-500 max-w-3xl mx-auto leading-relaxed">
          Razorpay billing for the v2 plans is rolling out. Click <strong>Switch</strong> to be redirected to
          the secure checkout flow with your selected plan, seat count and add-ons pre-filled.
        </p>
      </div>
    </DashboardLayout>
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
  const href = plan.enterprise
    ? '/#contact'
    : `/checkout?plan=${plan.code[cycle]}&seats=${seats}&currency=${currency.toLowerCase()}${
        selectedAddons.size > 0
          ? `&addons=${Array.from(selectedAddons).map((id) => ADDON_META[id].code[cycle]).join(',')}`
          : ''
      }`;

  return (
    <div className={`group relative bg-gradient-to-br rounded-2xl p-[1px] transition-all duration-300 hover:-translate-y-1 ${
      plan.highlighted
        ? 'from-emerald-500/60 via-emerald-400/30 to-transparent shadow-2xl shadow-emerald-500/15'
        : plan.enterprise
          ? 'from-violet-500/50 via-violet-400/25 to-transparent shadow-2xl shadow-violet-500/15'
          : 'from-dark-700 to-dark-800 hover:from-emerald-500/30 hover:to-transparent'
    }`}>
      <div className="relative bg-dark-800 rounded-2xl p-5 h-full flex flex-col">
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

        <div className="text-center mb-4">
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

        <ul className="space-y-2 mb-4 flex-1">
          {plan.features.map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px] text-gray-300">
              <i className="ri-check-line text-emerald-400 text-sm mt-0.5 shrink-0" />
              <span className="leading-relaxed">{f}</span>
            </li>
          ))}
          {plan.notIncluded?.map((f, i) => (
            <li key={`nx-${i}`} className="flex items-start gap-2 text-[12px] text-gray-600">
              <i className="ri-close-line text-gray-600 text-sm mt-0.5 shrink-0" />
              <span className="leading-relaxed line-through">{f}</span>
            </li>
          ))}
        </ul>

        {plan.available_addons.length > 0 && (
          <div className="mb-4 space-y-2 border-t border-dark-700 pt-4">
            <p className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-2">Optional add-ons</p>
            {plan.available_addons.map((id) => (
              <AddonToggle
                key={id}
                active={selectedAddons.has(id)}
                meta={ADDON_META[id]}
                cycle={cycle}
                fmt={fmt}
                onToggle={() => onToggleAddon(id)}
              />
            ))}
          </div>
        )}

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
        <button type="button" onClick={() => setExpanded((e) => !e)} className="flex items-center gap-2 flex-1 text-left min-w-0" aria-expanded={expanded}>
          <i className={`${meta.icon} text-sm ${active ? 'text-emerald-400' : 'text-gray-400'} shrink-0`} />
          <div className="min-w-0">
            <p className={`text-xs font-medium truncate ${active ? 'text-emerald-200' : 'text-gray-200'}`}>{meta.label}</p>
            <p className="text-[10px] text-gray-500">+{fmt(unit.inr, unit.usd)} / seat / {cycle === 'yearly' ? 'year' : 'month'}</p>
          </div>
          <i className={`ri-arrow-${expanded ? 'up' : 'down'}-s-line text-gray-500 shrink-0`} />
        </button>
        <button type="button" onClick={onToggle}
          className={`shrink-0 w-9 h-5 rounded-full relative transition-colors ${active ? 'bg-emerald-500' : 'bg-dark-700'}`}
          aria-pressed={active} aria-label={active ? `Remove ${meta.label}` : `Add ${meta.label}`}>
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${active ? 'left-4' : 'left-0.5'}`} />
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
            <button type="button" onClick={onToggle}
              className="mt-2.5 w-full py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[11px] font-medium">
              + Add this to my plan
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tint: Record<string, string> = {
    active:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    trial:   'bg-amber-500/15 text-amber-400 border-amber-500/30',
    expired: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  };
  return <span className={`text-xs px-3 py-1 rounded-full border ${tint[status] ?? 'bg-dark-700 text-gray-400 border-dark-600'}`}>{status}</span>;
}
