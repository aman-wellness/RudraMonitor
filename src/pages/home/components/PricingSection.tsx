import { useNavigate } from 'react-router-dom';
import PlanGrid from '@/components/PlanGrid';

// Public-facing pricing display. Thin wrapper around the shared <PlanGrid />
// so the landing, /subscription, and /admin-portal call sites all render
// the same layout. CTA routes anonymous visitors to /signup with the
// chosen plan code + seats + add-ons in the URL query string so the
// signup flow can pre-populate Razorpay checkout (Phase 7).

export default function PricingSection() {
  const navigate = useNavigate();
  return (
    <section id="pricing" className="relative bg-dark-900 py-16 md:py-24 overflow-hidden">
      {/* Background flourish — subtle glow for the 3D feel */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/4 w-96 h-96 bg-emerald-500/5 blur-3xl rounded-full" />
        <div className="absolute bottom-1/3 right-1/4 w-96 h-96 bg-violet-500/5 blur-3xl rounded-full" />
      </div>

      <div className="relative w-full px-4 md:px-8 lg:px-12 max-w-7xl mx-auto">
        <div className="text-center mb-10 md:mb-14">
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-4">
            <i className="ri-price-tag-3-line text-emerald-400 text-sm" />
            <span className="text-xs md:text-sm text-emerald-400 font-medium">Pricing</span>
          </div>
          <h2 className="text-2xl md:text-3xl lg:text-4xl font-poppins font-bold text-white mb-4">
            Simple per-seat pricing. Pay for what you use.
          </h2>
          <p className="text-sm md:text-base text-gray-400 max-w-2xl mx-auto">
            Pick a tier, pick your seat count, optionally stack add-ons. Every plan ships with
            a 14-day free trial — no credit card.
          </p>
        </div>

        <PlanGrid
          lockCurrency="INR"
          ctaLabelFor={(planCode, _isCurrent) =>
            planCode === 'enterprise' ? 'Contact Sales' : 'Start free trial'
          }
          onSelect={({ planCode, seats, addons, currency }) => {
            if (planCode === 'enterprise') {
              window.location.hash = 'contact';
              return;
            }
            const qs = new URLSearchParams({
              plan: planCode,
              seats: String(seats),
              currency: currency.toLowerCase(),
              ...(addons.length ? { addons: addons.join(',') } : {}),
            });
            navigate(`/signup?${qs.toString()}`);
          }}
        />

        <p className="text-center text-[11px] text-gray-500 mt-12 max-w-3xl mx-auto leading-relaxed">
          Indian customers billed in INR (+ 18% GST). International customers billed in USD via Razorpay.
          14-day free trial on all plans, no credit card required. Cancel anytime from the admin portal.
        </p>
      </div>
    </section>
  );
}
