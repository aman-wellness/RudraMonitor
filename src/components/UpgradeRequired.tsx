import { Link } from 'react-router-dom';

// Shown as the full-page body when a customer hits a feature their current
// plan doesn't include. Renders a friendly explanation + CTA to the
// subscription page where they can upgrade or add the relevant add-on.

interface Props {
  feature: string;        // human-readable feature name, e.g. "Data Loss Prevention"
  icon?: string;          // remixicon class, e.g. "ri-shield-keyhole-line"
  blurb?: string;         // optional 1-line explanation
  ctaLabel?: string;
}

export default function UpgradeRequired({
  feature,
  icon = 'ri-lock-2-line',
  blurb,
  ctaLabel = 'View plans',
}: Props) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center">
        <span className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-amber-500/15 text-amber-400 mb-5">
          <i className={`${icon} text-3xl`} />
        </span>
        <h2 className="text-xl md:text-2xl font-poppins font-semibold text-white mb-2">
          {feature} is not included in your plan
        </h2>
        <p className="text-sm text-gray-400 mb-6">
          {blurb ?? `Your current subscription doesn't include ${feature}. Upgrade or add it on to unlock this module for your whole team.`}
        </p>
        <Link
          to="/subscription"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium transition-colors"
        >
          <i className="ri-arrow-right-up-line" />
          {ctaLabel}
        </Link>
      </div>
    </div>
  );
}
