// Shared per-seat pricing grid. Fully DB-driven: every card you see here
// (plan name, blurb, price, features bulleted, available add-ons) comes
// from the `plans` table. Super-admin edits at /admin/plans propagate
// here on next mount.
//
// Three call sites consume this:
//   1. Landing page (PricingSection.tsx) — anonymous visitors
//   2. /subscription — signed-in customers
//   3. /admin-portal Billing tab — admin shell
//
// One Enterprise card is hardcoded as the last tile because Enterprise is
// "Contact Sales", not a real SKU you can self-checkout.

import { useMemo, useState } from 'react';
import { usePlans, type LivePlan } from '@/lib/usePlans';
import { expandFeatureBullets, FEATURE_BULLETS } from '@/lib/featureLabels';

export type Currency = 'INR' | 'USD';
export type Cycle = 'monthly' | 'yearly';

// A "plan group" is one row per unique tier name with both monthly +
// yearly variants paired up (when both exist). This is what we actually
// render as a card.
interface PlanGroup {
  name: string;
  description: string;
  monthly?: LivePlan;
  yearly?: LivePlan;
  features: string[];           // canonical feature codes (union of both variants)
  // Computed: feature codes the user is told this plan does NOT include.
  // Inferred from the global set minus the plan's features.
  notIncluded: string[];
  is_em_standalone: boolean;
  highlighted: boolean;
}

interface AddonCardData {
  // Stable key derived from the trimmed lowercased name so the
  // monthly/yearly variants pair.
  key: string;
  name: string;
  description: string;
  monthly?: LivePlan;
  yearly?: LivePlan;
  features: string[];  // canonical codes the addon adds
}

export interface PlanSelection {
  planCode: string;
  cycle: Cycle;
  seats: number;
  addons: string[];  // addon SKU codes for the chosen cycle
  currency: Currency;
}

export interface PlanGridProps {
  currentPlanCode?: string | null;
  disableCtas?: boolean;
  ctaLabelFor?: (planCode: string, isCurrent: boolean) => string;
  onSelect: (sel: PlanSelection) => void;
  defaultCurrency?: Currency;
  defaultCycle?: Cycle;
  defaultSeats?: number;
}

// Legacy plan codes that should map to a v2 tier for "current plan"
// highlighting. Each legacy code points at the v2 codes that represent
// the same product so the right card lights up.
const LEGACY_CURRENT_MAP: Record<string, string[]> = {
  'starter-5':       ['starter-m', 'starter-y'],
  'Starter-monthly': ['starter-m', 'starter-y'],
  'growth-25':       ['pro-m', 'pro-y'],
  'scale-100':       ['enterprise'],
  'em-unlimited':    ['em-m', 'em-y'],
};

const HIGHLIGHTED_NAME = 'Professional';  // the "Most Popular" card

// Build the canonical superset of features so each card can show
// "not-included" strikethroughs. Sourced from the FEATURE_BULLETS keys
// (excluding legacy aliases that aren't first-class capabilities).
const CANONICAL_FEATURES = ['monitoring_basic', 'screenshots', 'videos', 'live', 'remote', 'dlp', 'employee_management'];

export default function PlanGrid({
  currentPlanCode,
  disableCtas,
  ctaLabelFor,
  onSelect,
  defaultCurrency = 'INR',
  defaultCycle = 'monthly',
  defaultSeats = 10,
}: PlanGridProps) {
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [cycle, setCycle] = useState<Cycle>(defaultCycle);
  const [seats, setSeats] = useState(defaultSeats);
  const [selectedAddons, setSelectedAddons] = useState<Record<string, Set<string>>>({});
  const { plans, loaded } = usePlans();

  // Group non-addon plans by name so monthly + yearly variants share
  // one card.
  const planGroups: PlanGroup[] = useMemo(() => {
    const bases = plans.filter((p) => !p.is_addon);
    const byName = new Map<string, PlanGroup>();
    for (const p of bases) {
      const existing = byName.get(p.name);
      if (existing) {
        if (p.billing_cycle === 'monthly') existing.monthly = p;
        if (p.billing_cycle === 'yearly')  existing.yearly = p;
        existing.features = unionFeatures(existing.features, p.features_included);
        existing.is_em_standalone = existing.is_em_standalone || p.is_em_standalone;
      } else {
        byName.set(p.name, {
          name: p.name,
          description: deriveDescription(p),
          monthly: p.billing_cycle === 'monthly' ? p : undefined,
          yearly: p.billing_cycle === 'yearly' ? p : undefined,
          features: [...p.features_included],
          notIncluded: [],
          is_em_standalone: p.is_em_standalone,
          highlighted: p.name === HIGHLIGHTED_NAME,
        });
      }
    }
    // Compute notIncluded per group.
    for (const g of byName.values()) {
      g.notIncluded = CANONICAL_FEATURES.filter((c) => !g.features.includes(c));
    }
    // Stable ordering: lowest monthly price first, then by name.
    return Array.from(byName.values()).sort((a, b) => {
      const ap = a.monthly?.price_inr ?? a.yearly?.price_inr ?? 0;
      const bp = b.monthly?.price_inr ?? b.yearly?.price_inr ?? 0;
      if (ap !== bp) return ap - bp;
      return a.name.localeCompare(b.name);
    });
  }, [plans]);

  const addonCards: AddonCardData[] = useMemo(() => {
    const addons = plans.filter((p) => p.is_addon);
    const byKey = new Map<string, AddonCardData>();
    for (const a of addons) {
      const key = a.name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const existing = byKey.get(key);
      if (existing) {
        if (a.billing_cycle === 'monthly') existing.monthly = a;
        if (a.billing_cycle === 'yearly')  existing.yearly = a;
        existing.features = unionFeatures(existing.features, a.features_included);
      } else {
        byKey.set(key, {
          key,
          name: a.name,
          description: deriveDescription(a),
          monthly: a.billing_cycle === 'monthly' ? a : undefined,
          yearly: a.billing_cycle === 'yearly' ? a : undefined,
          features: [...a.features_included],
        });
      }
    }
    return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [plans]);

  const fmt = (inr: number, usd: number) =>
    currency === 'INR' ? `₹${inr.toLocaleString('en-IN')}` : `$${usd.toLocaleString('en-US')}`;

  // Yearly-savings hint, anchored to the lowest-priced monitoring tier
  // (the cheapest plan with monthly + yearly variants).
  const yearlySavingsPct = useMemo(() => {
    const candidate = planGroups.find((g) => g.monthly && g.yearly);
    if (!candidate) return 16;
    const m12 = (candidate.monthly?.price_inr ?? 0) * 12;
    const y = candidate.yearly?.price_inr ?? 0;
    if (m12 === 0) return 16;
    return Math.max(0, Math.round(((m12 - y) / m12) * 100));
  }, [planGroups]);

  const toggleAddon = (planName: string, addonKey: string) => {
    setSelectedAddons((prev) => {
      const cur = new Set(prev[planName] ?? []);
      if (cur.has(addonKey)) cur.delete(addonKey); else cur.add(addonKey);
      return { ...prev, [planName]: cur };
    });
  };

  // Which addons should we offer alongside this plan? Rule: an addon is
  // relevant when it adds at least one feature this plan doesn't already
  // include. So DLP-addon shows for Starter (no DLP) but not Professional
  // (already has DLP). EM-addon shows for Starter + Pro (no EM) but not
  // EM-standalone or anything with em.
  const addonsForPlan = (group: PlanGroup): AddonCardData[] =>
    addonCards.filter((a) => a.features.some((f) => !group.features.includes(f)));

  const isCurrentGroup = (g: PlanGroup): boolean => {
    if (!currentPlanCode) return false;
    const legacy = LEGACY_CURRENT_MAP[currentPlanCode];
    const targetCodes = legacy ?? [currentPlanCode];
    const groupCodes = [g.monthly?.code, g.yearly?.code].filter(Boolean) as string[];
    return groupCodes.some((c) => targetCodes.includes(c));
  };

  // The hardcoded Enterprise tile — always last, no DB row, no checkout.
  const enterpriseIsCurrent = currentPlanCode === 'enterprise' || currentPlanCode === 'scale-100';

  return (
    <div className="space-y-6">
      {/* Toggles + seat picker */}
      <div className="flex flex-wrap items-center justify-center gap-3">
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
            {yearlySavingsPct > 0 && (
              <span className="ml-1 text-[10px] bg-white/20 px-1.5 py-0.5 rounded">save {yearlySavingsPct}%</span>
            )}
          </button>
        </div>

        <div className="inline-flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-xl px-4 py-2">
          <i className="ri-team-line text-gray-400 text-sm" />
          <label htmlFor="plan-grid-seats" className="text-xs text-gray-300">Seats:</label>
          <button type="button" onClick={() => setSeats((s) => Math.max(1, s - 5))} className="w-6 h-6 rounded-md bg-dark-700 hover:bg-dark-600 text-white text-xs" aria-label="Decrease seats">−</button>
          <input id="plan-grid-seats" type="number" min={1} max={10000} value={seats}
            onChange={(e) => setSeats(Math.max(1, Math.min(10000, parseInt(e.target.value || '1', 10))))}
            className="w-14 text-center bg-dark-900 border border-dark-700 rounded-md py-1 text-xs text-white focus:outline-none focus:border-emerald-500" />
          <button type="button" onClick={() => setSeats((s) => Math.min(10000, s + 5))} className="w-6 h-6 rounded-md bg-dark-700 hover:bg-dark-600 text-white text-xs" aria-label="Increase seats">+</button>
        </div>
      </div>

      {/* Plan cards — dynamic from DB, then Enterprise */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Loading skeleton when no plans loaded yet */}
        {!loaded && planGroups.length === 0 && (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-96 bg-dark-800 border border-dark-700 rounded-2xl animate-pulse" />
            ))}
          </>
        )}

        {planGroups.map((group) => (
          <PlanCardView
            key={group.name}
            group={group}
            cycle={cycle}
            currency={currency}
            seats={seats}
            fmt={fmt}
            isCurrent={isCurrentGroup(group)}
            disableCtas={!!disableCtas}
            ctaLabelFor={ctaLabelFor}
            addons={addonsForPlan(group)}
            selectedAddons={selectedAddons[group.name] ?? new Set()}
            onToggleAddon={(addonKey) => toggleAddon(group.name, addonKey)}
            onSelect={() => {
              const variant = cycle === 'yearly' ? group.yearly : group.monthly;
              if (!variant) return;
              const chosen = selectedAddons[group.name] ?? new Set<string>();
              const addonCodes = Array.from(chosen)
                .map((k) => addonCards.find((a) => a.key === k))
                .map((a) => (cycle === 'yearly' ? a?.yearly?.code : a?.monthly?.code))
                .filter(Boolean) as string[];
              onSelect({
                planCode: variant.code,
                cycle,
                seats,
                addons: addonCodes,
                currency,
              });
            }}
          />
        ))}

        {/* Enterprise — hardcoded last tile */}
        <EnterpriseCard
          isCurrent={enterpriseIsCurrent}
          disableCtas={!!disableCtas}
          ctaLabelFor={ctaLabelFor}
          onSelect={() => onSelect({ planCode: 'enterprise', cycle, seats, addons: [], currency })}
        />
      </div>
    </div>
  );
}

// ---- helpers ----

function unionFeatures(a: string[], b: string[]): string[] {
  const set = new Set([...a, ...b]);
  return Array.from(set);
}

// If the DB row has a description, use it. Otherwise synthesise a sensible
// blurb from the name + features so a super-admin-added tier still reads
// well without manual copy.
function deriveDescription(p: LivePlan): string {
  // The DB row's description column isn't on LivePlan today (kept lean) —
  // for now we just synthesise. Phase 8 (admin pricing editor) will
  // surface description so super-admin can override.
  if (p.is_addon) return `Per-seat ${p.name}. Stack onto any compatible plan.`;
  if (p.is_em_standalone) return 'EM-only — IT lifecycle. No monitoring agents.';
  if (p.features_included.length === 1 && p.features_included[0] === 'monitoring_basic') {
    return 'Basic activity monitoring for small teams.';
  }
  if (p.features_included.includes('remote')) {
    return 'Full visibility — screenshots, videos, live + remote, DLP.';
  }
  return `${p.name} plan.`;
}

// ---- Plan card ----

function PlanCardView({
  group, cycle, currency, seats, fmt, isCurrent, disableCtas, ctaLabelFor,
  addons, selectedAddons, onToggleAddon, onSelect,
}: {
  group: PlanGroup;
  cycle: Cycle;
  currency: Currency;
  seats: number;
  fmt: (inr: number, usd: number) => string;
  isCurrent: boolean;
  disableCtas: boolean;
  ctaLabelFor?: (planCode: string, isCurrent: boolean) => string;
  addons: AddonCardData[];
  selectedAddons: Set<string>;
  onToggleAddon: (addonKey: string) => void;
  onSelect: () => void;
}) {
  const variant = cycle === 'yearly' ? group.yearly : group.monthly;
  const cycleWord = cycle === 'yearly' ? 'year' : 'month';

  // If the chosen cycle doesn't exist for this plan, fall back gracefully
  // to the other one (e.g. super-admin created only a yearly SKU).
  const effective = variant ?? group.yearly ?? group.monthly;
  if (!effective) return null;

  const addonsTotal = Array.from(selectedAddons).reduce(
    (acc, addonKey) => {
      const a = addons.find((x) => x.key === addonKey);
      if (!a) return acc;
      const v = cycle === 'yearly' ? a.yearly : a.monthly;
      if (!v) return acc;
      return { inr: acc.inr + v.price_inr, usd: acc.usd + (v.price_usd ?? 0) };
    },
    { inr: 0, usd: 0 },
  );
  const planTotal = { inr: effective.price_inr * seats, usd: effective.price_usd * seats };
  const grandTotal = {
    inr: planTotal.inr + addonsTotal.inr * seats,
    usd: planTotal.usd + addonsTotal.usd * seats,
  };

  const featuresBullets = expandFeatureBullets(group.features);
  const notIncludedBullets = expandFeatureBullets(group.notIncluded);

  const defaultLabel = (() => {
    if (isCurrent) return 'Active Plan';
    return `Switch to ${group.name}`;
  })();
  const label = ctaLabelFor ? ctaLabelFor(effective.code, isCurrent) : defaultLabel;

  return (
    <div className={`group relative bg-gradient-to-br rounded-2xl p-[1px] transition-all duration-300 hover:-translate-y-1 ${
      isCurrent
        ? 'from-emerald-500/80 via-emerald-400/40 to-emerald-500/20 shadow-2xl shadow-emerald-500/30'
        : group.highlighted
          ? 'from-emerald-500/60 via-emerald-400/30 to-transparent shadow-2xl shadow-emerald-500/15'
          : 'from-dark-700 to-dark-800 hover:from-emerald-500/30 hover:to-transparent'
    }`}>
      <div className="relative bg-dark-800 rounded-2xl p-5 h-full flex flex-col">
        {isCurrent && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-emerald-600 text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full shadow-lg shadow-emerald-500/40">
              Current Plan
            </span>
          </div>
        )}
        {!isCurrent && group.highlighted && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="bg-emerald-500 text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full shadow-lg shadow-emerald-500/40">
              Most Popular
            </span>
          </div>
        )}

        <div className="text-center mb-4 pt-2">
          <h3 className="text-lg font-poppins font-bold text-white mb-1">{group.name}</h3>
          <p className="text-xs text-gray-500 leading-relaxed min-h-[2.5em]">{group.description}</p>
        </div>

        <div className="text-center mb-4">
          <div>
            <span className="text-3xl font-bold text-white tabular-nums">{fmt(effective.price_inr, effective.price_usd)}</span>
            <span className="text-xs text-gray-500 ml-1">/ seat / {effective.billing_cycle === 'yearly' ? 'year' : 'month'}</span>
          </div>
          <p className="text-[11px] text-emerald-400 mt-1.5 font-medium">
            {seats} seat{seats === 1 ? '' : 's'} = {fmt(planTotal.inr, planTotal.usd)} / {effective.billing_cycle === 'yearly' ? 'year' : 'month'}
          </p>
          {group.is_em_standalone && (
            <p className="text-[10px] text-amber-300/80 mt-1">Up to 2,000 users — Enterprise above that.</p>
          )}
          {variant === undefined && (
            <p className="text-[10px] text-amber-300/80 mt-1">{cycle === 'yearly' ? 'Yearly' : 'Monthly'} variant not available — showing {effective.billing_cycle}.</p>
          )}
        </div>

        <ul className="space-y-2 mb-4 flex-1">
          {featuresBullets.map((f, i) => (
            <li key={`y-${i}`} className="flex items-start gap-2 text-[12px] text-gray-300">
              <i className="ri-check-line text-emerald-400 text-sm mt-0.5 shrink-0" />
              <span className="leading-relaxed">{f}</span>
            </li>
          ))}
          {notIncludedBullets.slice(0, 4).map((f, i) => (
            <li key={`n-${i}`} className="flex items-start gap-2 text-[12px] text-gray-600">
              <i className="ri-close-line text-gray-600 text-sm mt-0.5 shrink-0" />
              <span className="leading-relaxed line-through">{f}</span>
            </li>
          ))}
        </ul>

        {addons.length > 0 && (
          <div className="mb-4 space-y-2 border-t border-dark-700 pt-4">
            <p className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-2">Optional add-ons</p>
            {addons.map((a) => (
              <AddonToggle
                key={a.key}
                active={selectedAddons.has(a.key)}
                addon={a}
                cycle={cycle}
                fmt={fmt}
                onToggle={() => onToggleAddon(a.key)}
              />
            ))}
          </div>
        )}

        {selectedAddons.size > 0 && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-center">
            <p className="text-[10px] uppercase tracking-wider text-emerald-400 font-medium">Total with add-ons</p>
            <p className="text-base font-bold text-white">
              {fmt(grandTotal.inr, grandTotal.usd)} / {cycleWord}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={onSelect}
          disabled={isCurrent || disableCtas}
          className={`block text-center w-full py-2.5 rounded-lg font-medium text-sm transition-all ${
            isCurrent
              ? 'bg-emerald-500/15 text-emerald-300 cursor-default border border-emerald-500/30'
              : disableCtas
                ? 'bg-dark-700 text-gray-500 border border-dark-600 cursor-not-allowed'
                : group.highlighted
                  ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'
                  : 'border border-dark-600 hover:border-emerald-500 text-white hover:text-emerald-400'
          }`}
        >
          {label}
        </button>
      </div>
    </div>
  );
}

// ---- Addon toggle inside a plan card ----

function AddonToggle({
  active, addon, cycle, fmt, onToggle,
}: {
  active: boolean;
  addon: AddonCardData;
  cycle: Cycle;
  fmt: (inr: number, usd: number) => string;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const variant = cycle === 'yearly' ? addon.yearly : addon.monthly;
  if (!variant) return null;

  const featureBullets = (FEATURE_BULLETS[addon.features[0]] ?? []).length > 0
    ? expandFeatureBullets(addon.features)
    : addon.features;

  const icon = inferAddonIcon(addon.features);

  return (
    <div className={`rounded-lg border transition-all ${
      active ? 'bg-emerald-500/8 border-emerald-500/40' : 'bg-dark-900/40 border-dark-700 hover:border-dark-600'
    }`}>
      <div className="flex items-center justify-between gap-2 p-2.5">
        <button type="button" onClick={() => setExpanded((e) => !e)} className="flex items-center gap-2 flex-1 text-left min-w-0" aria-expanded={expanded}>
          <i className={`${icon} text-sm ${active ? 'text-emerald-400' : 'text-gray-400'} shrink-0`} />
          <div className="min-w-0">
            <p className={`text-xs font-medium truncate ${active ? 'text-emerald-200' : 'text-gray-200'}`}>{addon.name}</p>
            <p className="text-[10px] text-gray-500">+{fmt(variant.price_inr, variant.price_usd)} / seat / {cycle === 'yearly' ? 'year' : 'month'}</p>
          </div>
          <i className={`ri-arrow-${expanded ? 'up' : 'down'}-s-line text-gray-500 shrink-0`} />
        </button>
        <button type="button" onClick={onToggle}
          className={`shrink-0 w-9 h-5 rounded-full relative transition-colors ${active ? 'bg-emerald-500' : 'bg-dark-700'}`}
          aria-pressed={active} aria-label={active ? `Remove ${addon.name}` : `Add ${addon.name}`}>
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${active ? 'left-4' : 'left-0.5'}`} />
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 border-t border-dark-700 mt-1 pt-2.5">
          <p className="text-[11px] text-gray-400 mb-2 leading-relaxed">{addon.description}</p>
          <ul className="space-y-1">
            {featureBullets.map((f) => (
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

function inferAddonIcon(features: string[]): string {
  if (features.includes('dlp')) return 'ri-shield-keyhole-line';
  if (features.includes('employee_management')) return 'ri-team-line';
  return 'ri-add-circle-line';
}

// ---- Hardcoded Enterprise card ----

function EnterpriseCard({
  isCurrent, disableCtas, ctaLabelFor, onSelect,
}: {
  isCurrent: boolean;
  disableCtas: boolean;
  ctaLabelFor?: (planCode: string, isCurrent: boolean) => string;
  onSelect: () => void;
}) {
  const label = ctaLabelFor ? ctaLabelFor('enterprise', isCurrent) : (isCurrent ? 'Active Plan' : 'Contact Sales');
  return (
    <div className={`group relative bg-gradient-to-br rounded-2xl p-[1px] transition-all duration-300 hover:-translate-y-1 ${
      isCurrent
        ? 'from-emerald-500/80 via-emerald-400/40 to-emerald-500/20 shadow-2xl shadow-emerald-500/30'
        : 'from-violet-500/50 via-violet-400/25 to-transparent shadow-2xl shadow-violet-500/15'
    }`}>
      <div className="relative bg-dark-800 rounded-2xl p-5 h-full flex flex-col">
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className={`text-white text-[10px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full shadow-lg ${
            isCurrent ? 'bg-emerald-600 shadow-emerald-500/40' : 'bg-violet-500 shadow-violet-500/40'
          }`}>
            {isCurrent ? 'Current Plan' : 'Contact Sales'}
          </span>
        </div>
        <div className="text-center mb-4 pt-2">
          <h3 className="text-lg font-poppins font-bold text-white mb-1">Enterprise</h3>
          <p className="text-xs text-gray-500 leading-relaxed min-h-[2.5em]">Everything, unlimited. Custom SLA + dedicated CSM.</p>
        </div>
        <div className="text-center mb-4">
          <span className="text-2xl font-bold text-white">Custom</span>
        </div>
        <ul className="space-y-2 mb-4 flex-1">
          {['All Professional + EM features', 'Unlimited users', 'Dedicated success manager', 'Custom SLA + uptime guarantee', 'SSO + custom data retention', 'On-prem deployment available'].map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px] text-gray-300">
              <i className="ri-check-line text-emerald-400 text-sm mt-0.5 shrink-0" />
              <span className="leading-relaxed">{f}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onSelect}
          disabled={disableCtas}
          className={`block text-center w-full py-2.5 rounded-lg font-medium text-sm transition-all ${
            disableCtas
              ? 'bg-dark-700 text-gray-500 border border-dark-600 cursor-not-allowed'
              : 'bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/30 text-violet-200'
          }`}
        >
          {label}
        </button>
      </div>
    </div>
  );
}
