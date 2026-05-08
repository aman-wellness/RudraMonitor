import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Shared split-screen login surface — reused across customer, partner, super-admin
 * and signup pages so they all feel like the same product. Each portal picks its
 * own accent palette and illustration; the shell, spacing, mobile fallback and
 * autofill-friendly input theming stay consistent.
 */

export type LoginAccent = 'indigo' | 'violet' | 'purple' | 'emerald';

interface Props {
  accent?: LoginAccent;
  brandLabel?: string;            // e.g. "TrackForce" or "TrackForce Partners"
  brandIcon?: string;             // remix icon class for the small square logo
  illustrationUrl?: string;       // remote SVG; safe to omit for minimal pages
  illustrationCaption?: string;
  illustrationSubtitle?: string;
  title: string;
  subtitle?: string;
  /** Hide the left illustration column entirely (e.g. /super internal-only). */
  minimal?: boolean;
  children: ReactNode;
  /** Optional footer content under the form (e.g. "Don't have an account?…"). */
  footer?: ReactNode;
}

const ACCENTS: Record<LoginAccent, { bg: string; ring: string; chip: string; gradient: string }> = {
  indigo:  { bg: 'bg-indigo-500',  ring: 'focus:border-indigo-500 focus:ring-indigo-500',  chip: 'bg-indigo-50',  gradient: 'from-slate-50 to-indigo-50/40' },
  violet:  { bg: 'bg-violet-500',  ring: 'focus:border-violet-500 focus:ring-violet-500',  chip: 'bg-violet-50',  gradient: 'from-slate-50 to-violet-50/40' },
  purple:  { bg: 'bg-purple-500',  ring: 'focus:border-purple-500 focus:ring-purple-500',  chip: 'bg-purple-50',  gradient: 'from-slate-50 to-purple-50/40' },
  emerald: { bg: 'bg-emerald-500', ring: 'focus:border-emerald-500 focus:ring-emerald-500', chip: 'bg-emerald-50', gradient: 'from-slate-50 to-emerald-50/40' },
};

export default function LoginLayout({
  accent = 'indigo',
  brandLabel = 'TrackForce',
  brandIcon = 'ri-shield-check-line',
  illustrationUrl,
  illustrationCaption,
  illustrationSubtitle,
  title,
  subtitle,
  minimal,
  children,
  footer,
}: Props) {
  const a = ACCENTS[accent];
  // Expose the accent classes to consumers for inputs / buttons via context-free
  // approach: we return the form area unchanged; consumers compose their own
  // inputs but reference the same `useLoginAccentClasses` if desired (below).
  // For now, the children are responsible for using accent colours that match.

  const grid = minimal ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2';

  return (
    <div className={`min-h-screen grid ${grid} bg-white`}>
      {/* LEFT — illustration panel (skipped on minimal surfaces) */}
      {!minimal && (
        <div className={`hidden lg:flex relative items-center justify-center bg-gradient-to-br ${a.gradient} overflow-hidden p-12`}>
          <div className="absolute top-12 left-12 w-3 h-3 rounded-full bg-current opacity-20" />
          <div className="absolute bottom-20 right-16 w-2 h-2 rounded-full bg-current opacity-30" />
          <div className="absolute top-1/3 right-20 w-1.5 h-1.5 rounded-full bg-current opacity-40" />

          <div className="relative z-10 max-w-md text-center">
            <Link to="/" className="inline-flex items-center gap-2 mb-10">
              <span className={`w-9 h-9 rounded-lg ${a.bg} flex items-center justify-center`}>
                <i className={`${brandIcon} text-white text-lg`} />
              </span>
              <span className="text-slate-900 font-poppins font-bold text-xl">{brandLabel}</span>
            </Link>

            {illustrationUrl && (
              <img
                src={illustrationUrl}
                alt=""
                className="w-full h-auto max-h-[420px] mx-auto mb-8"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            )}

            {illustrationCaption && (
              <h2 className="text-2xl font-poppins font-bold text-slate-900 mb-2">{illustrationCaption}</h2>
            )}
            {illustrationSubtitle && (
              <p className="text-sm text-slate-500 leading-relaxed">{illustrationSubtitle}</p>
            )}
          </div>
        </div>
      )}

      {/* RIGHT — form panel */}
      <div className="flex items-center justify-center px-6 py-12 lg:py-0">
        <div className="w-full max-w-md">
          {/* Mobile-only / minimal-mode brand */}
          <Link to="/" className={`${minimal ? '' : 'lg:hidden'} inline-flex items-center gap-2 mb-8`}>
            <span className={`w-9 h-9 rounded-lg ${a.bg} flex items-center justify-center`}>
              <i className={`${brandIcon} text-white text-lg`} />
            </span>
            <span className="text-slate-900 font-poppins font-bold text-xl">{brandLabel}</span>
          </Link>

          <h1 className="text-3xl md:text-4xl font-poppins font-bold text-slate-900 mb-2">{title}</h1>
          {subtitle && <p className="text-sm text-slate-500 mb-8">{subtitle}</p>}

          <div className={`login-accent-${accent}`}>{children}</div>

          {footer && <div className="mt-8">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

/** Shared input + button class strings so the form bodies inside LoginLayout
 *  stay short and the visual language stays consistent. */
export const loginInputClass =
  'w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 transition-colors';

export const loginButtonBase =
  'w-full disabled:opacity-60 disabled:cursor-not-allowed text-white py-3 rounded-lg font-medium transition-all duration-200 shadow-lg mt-2';

export const loginAccentBg: Record<LoginAccent, string> = {
  indigo:  'bg-indigo-500 hover:bg-indigo-600 shadow-indigo-500/30 focus:border-indigo-500 focus:ring-indigo-500',
  violet:  'bg-violet-500 hover:bg-violet-600 shadow-violet-500/30 focus:border-violet-500 focus:ring-violet-500',
  purple:  'bg-purple-500 hover:bg-purple-600 shadow-purple-500/30 focus:border-purple-500 focus:ring-purple-500',
  emerald: 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-500/30 focus:border-emerald-500 focus:ring-emerald-500',
};
