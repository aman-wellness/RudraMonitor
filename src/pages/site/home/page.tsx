import '@/styles/rudrans-site.css';
import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import SiteHeader from '../SiteHeader';
import { useSeo } from '@/lib/seo';

/* ------------------------------------------------------------------ *
 * Ported data (from the dc-runtime <script data-dc-script> renderVals)
 * ------------------------------------------------------------------ */
const showPricing = true;

const heroHeights = [42, 58, 40, 72, 30, 24, 60, 88, 56, 50, 44];
const heroBars = heroHeights.map((h, i) => ({
  h: h + '%',
  delay: i * 0.06 + 's',
  color: i === 5 ? 'var(--line2)' : 'linear-gradient(180deg,#14B8A6,#0D9488)',
}));

const topApps = (
  [
    ['F', '#F24E1E', 'Figma', '2h 45m', '32%'],
    ['C', '#4285F4', 'Chrome', '2h 15m', '24%'],
    ['V', '#007ACC', 'VS Code', '1h 35m', '18%'],
    ['S', '#611F69', 'Slack', '1h 10m', '12%'],
    ['N', '#1B1B1B', 'Notion', '45m', '6%'],
  ] as const
).map(([letter, bg, name, time, pct]) => ({ letter, bg, name, time, pct, w: pct }));

const deptRows = [
  { letter: '</>', bg: 'var(--blue-soft)', color: 'var(--blue)', name: 'Engineering', pct: '92%' },
  { letter: 'Pr', bg: 'rgba(124,58,237,0.1)', color: '#7C3AED', name: 'Product', pct: '88%' },
  { letter: 'Sa', bg: 'var(--amber-soft)', color: 'var(--amber)', name: 'Sales', pct: '84%' },
  { letter: 'Mk', bg: 'rgba(2,132,199,0.1)', color: '#0284C7', name: 'Marketing', pct: '76%' },
  { letter: 'Su', bg: 'rgba(220,38,38,0.08)', color: '#DC2626', name: 'Support', pct: '68%' },
];

type Plan = {
  name: string;
  tagline: string;
  popular: boolean;
  custom: boolean;
  hasPrice: boolean;
  price: string;
  cta: string;
  ctaBg: string;
  ctaColor: string;
  ctaBorder: string;
  border: string;
  plusLabel: string | false;
  feats: string[];
};

const plans: Plan[] = [
  {
    name: 'Starter',
    tagline: 'Perfect for small teams getting started.',
    popular: false,
    custom: false,
    hasPrice: true,
    price: '159',
    cta: 'Start free trial',
    ctaBg: 'var(--card)',
    ctaColor: 'var(--blue)',
    ctaBorder: '1.5px solid var(--line2)',
    border: '1px solid var(--line)',
    plusLabel: false,
    feats: ['Activity monitoring', 'Web & app usage', 'Live screen view', 'Basic reports', 'Email support'],
  },
  {
    name: 'Professional',
    tagline: 'For growing teams that need more control.',
    popular: true,
    custom: false,
    hasPrice: true,
    price: '249',
    cta: 'Start free trial',
    ctaBg: 'var(--blue)',
    ctaColor: '#FFFFFF',
    ctaBorder: 'none',
    border: '2px solid var(--blue)',
    plusLabel: 'Everything in Starter, plus',
    feats: [
      'Advanced reports & insights',
      'USB & device control',
      'Data loss prevention (DLP)',
      'Policy engine',
      'Priority support',
    ],
  },
  {
    name: 'Business',
    tagline: 'For large teams with advanced needs.',
    popular: false,
    custom: false,
    hasPrice: true,
    price: '399',
    cta: 'Start free trial',
    ctaBg: 'var(--card)',
    ctaColor: 'var(--blue)',
    ctaBorder: '1.5px solid var(--line2)',
    border: '1px solid var(--line)',
    plusLabel: 'Everything in Professional, plus',
    feats: [
      'Role-based access control',
      'Custom policy rules',
      'API access',
      'Integration support',
      'Dedicated account manager',
    ],
  },
  {
    name: 'Enterprise',
    tagline: 'For organizations with custom requirements.',
    popular: false,
    custom: true,
    hasPrice: false,
    price: '',
    cta: 'Contact sales',
    ctaBg: 'var(--card)',
    ctaColor: 'var(--blue)',
    ctaBorder: '1.5px solid var(--line2)',
    border: '1px solid var(--line)',
    plusLabel: 'Everything in Business, plus',
    feats: ['On-premise deployment', 'SAML / SSO', 'Custom integrations', 'SLA & dedicated support'],
  },
];

const ctaUsers = [
  { init: 'PS', bg: '#DB2777', name: 'Priya Sharma', time: '7h 45m' },
  { init: 'RV', bg: '#0D9488', name: 'Rahul Verma', time: '6h 21m' },
  { init: 'AS', bg: '#7C3AED', name: 'Amit Singh', time: '5h 18m' },
  { init: 'NK', bg: '#0284C7', name: 'Neha Kapoor', time: '4h 32m' },
  { init: 'VJ', bg: '#D97706', name: 'Vikram Joshi', time: '4h 05m' },
];

/* ------------------------------------------------------------------ *
 * Hover helpers (implements the source `style-hover` attributes)
 * ------------------------------------------------------------------ */
function HoverA({
  base,
  hover,
  children,
  ...rest
}: { base: React.CSSProperties; hover: React.CSSProperties; children?: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const [h, setH] = useState(false);
  return (
    <a {...rest} style={{ ...base, ...(h ? hover : {}) }} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}>
      {children}
    </a>
  );
}

function HoverLink({
  to,
  base,
  hover,
  children,
}: {
  to: string;
  base: React.CSSProperties;
  hover: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const [h, setH] = useState(false);
  return (
    <Link to={to} style={{ ...base, ...(h ? hover : {}) }} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}>
      {children}
    </Link>
  );
}

function HoverButton({
  base,
  hover,
  children,
  ...rest
}: { base: React.CSSProperties; hover: React.CSSProperties; children?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [h, setH] = useState(false);
  return (
    <button {...rest} style={{ ...base, ...(h ? hover : {}) }} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}>
      {children}
    </button>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <HoverA href={href} base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>
      {children}
    </HoverA>
  );
}

/* Green-circle check used in the feature-card lists */
function FeatCheck() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="#0D9488">
      <circle cx="12" cy="12" r="11" />
      <path d="m8 12.5 2.6 2.6L16.5 9" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FeatItem({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13.5px', fontWeight: 500 }}>
      <FeatCheck />
      {children}
    </span>
  );
}

function useMax(px: number) {
  const [m, setM] = useState(() => window.matchMedia(`(max-width:${px}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${px}px)`);
    const on = () => setM(mq.matches); on();
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, [px]);
  return m;
}

export default function Home() {
  useSeo('home');
  const tablet = useMax(900);
  const phone = useMax(600);
  return (
    <div className="rd-site">
      <SiteHeader home />

      <main style={{ display: 'contents' }}>

      {/* ---------- HERO ---------- */}
      <section id="top" style={{ position: 'relative', overflow: 'hidden', background: 'linear-gradient(180deg,var(--bg2),var(--bg))' }}>
        <div
          style={{
            position: 'relative',
            maxWidth: '1400px',
            margin: '0 auto',
            padding: phone ? '70px 20px 76px' : '70px 40px 76px',
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
            gap: '56px',
            alignItems: 'center',
            ...(tablet ? { gridTemplateColumns: 'minmax(0,1fr)', gap: '32px' } : {}),
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '22px' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.1em',
                color: 'var(--blue)',
                background: 'var(--blue-soft)',
                border: '1px solid var(--line)',
                padding: '7px 14px',
                borderRadius: '999px',
              }}
            >
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--green)', animation: 'rd-pulse 2s ease-in-out infinite' }} />
              LIVE · EMPLOYEE MONITORING &amp; DLP
            </span>
            <h1 style={{ margin: 0, fontSize: 'clamp(32px,3.8vw,56px)', lineHeight: 1.14, letterSpacing: '-0.03em', fontWeight: 700 }}>
              <span style={{ whiteSpace: 'nowrap' }}>See what's happening.</span>
              <br />
              <span style={{ whiteSpace: 'nowrap' }}>
                with your{' '}
                <span
                  style={{
                    color: 'var(--blue)',
                    background: 'linear-gradient(90deg,#0D9488,#2DD4BF)',
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    fontWeight: 700,
                  }}
                >
                  Rudrans.
                </span>
              </span>
            </h1>
            <p style={{ margin: 0, fontSize: '18px', lineHeight: 1.75, color: 'var(--ink2)', maxWidth: '520px', textWrap: 'pretty' }}>
              Rudrans gives businesses real-time visibility into employee activity, productivity and security — from one secure workspace. A
              lightweight agent installs in minutes and stays out of your team's way.
            </p>
            <p style={{ margin: 0, fontSize: '18px', lineHeight: 1.75, color: 'var(--ink2)', maxWidth: '520px', textWrap: 'pretty' }}>
              From live screens and activity timelines to DLP and device control, every insight your admins need streams into one dashboard — so
              decisions are based on facts, not guesswork.
            </p>
            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
              <HoverA
                href="#pricing"
                base={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'var(--blue)',
                  color: '#FFFFFF',
                  fontWeight: 700,
                  fontSize: '15.5px',
                  padding: '15px 28px',
                  borderRadius: '12px',
                  transition: 'all 0.25s ease',
                }}
                hover={{ background: 'var(--blue2)', color: '#FFFFFF', transform: 'translateY(-2px)' }}
              >
                Start free trial <span style={{ fontWeight: 400 }}>→</span>
              </HoverA>
              <HoverA
                href="#how"
                base={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'var(--card)',
                  border: '1.5px solid var(--line2)',
                  color: 'var(--ink)',
                  fontWeight: 700,
                  fontSize: '15.5px',
                  padding: '15px 28px',
                  borderRadius: '12px',
                  transition: 'all 0.25s ease',
                }}
                hover={{ border: '1.5px solid var(--blue)', color: 'var(--blue)', transform: 'translateY(-2px)' }}
              >
                See how it works
              </HoverA>
            </div>
          </div>

          {/* Hero dashboard mock */}
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', inset: '6% -4% auto', height: '80%', background: 'radial-gradient(ellipse at 50% 40%,var(--blue-soft),transparent 70%)' }} />
            <div
              style={{
                position: 'relative',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: '20px',
                boxShadow: 'var(--shadow)',
                padding: '18px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
                animation: 'rd-float 6s ease-in-out infinite',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px' }}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <span style={{ fontWeight: 700, fontSize: '16px' }}>Welcome back, Admin 👋</span>
                  <span style={{ fontSize: '11.5px', color: 'var(--ink3)' }}>Here's what's happening with your team today.</span>
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2.1" strokeLinecap="round">
                      <circle cx="11" cy="11" r="7" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                    <span style={{ position: 'relative', display: 'flex' }}>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--ink3)"
                        strokeWidth="2.1"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ animation: 'rd-bell 5s ease-in-out infinite', transformOrigin: 'top center' }}
                      >
                        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                      </svg>
                      <span
                        style={{
                          position: 'absolute',
                          top: '-6px',
                          right: '-6px',
                          minWidth: '13px',
                          height: '13px',
                          borderRadius: '999px',
                          background: 'var(--blue)',
                          color: '#FFFFFF',
                          fontSize: '8.5px',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          animation: 'rd-count-glow 2.5s infinite',
                        }}
                      >
                        3
                      </span>
                    </span>
                    <span
                      style={{
                        width: '30px',
                        height: '30px',
                        borderRadius: '50%',
                        background: 'linear-gradient(160deg,#14B8A6,#0D9488)',
                        color: '#FFFFFF',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '12px',
                        fontWeight: 700,
                      }}
                    >
                      A
                    </span>
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '7px',
                      fontSize: '10.5px',
                      fontWeight: 600,
                      color: 'var(--ink2)',
                      border: '1px solid var(--line2)',
                      background: 'var(--card)',
                      padding: '5px 11px',
                      borderRadius: '8px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2" />
                      <path d="M16 2v4M8 2v4M3 10h18" />
                    </svg>
                    May 12 – May 18{' '}
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
                    </svg>
                  </span>
                </span>
              </div>

              {/* KPI tiles */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '8px' }}>
                <div style={{ background: 'var(--tint)', border: '1px solid var(--line)', borderRadius: '12px', padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: '7px', minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--ink2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Active employees</span>
                    <span style={{ flex: 'none', width: '26px', height: '26px', borderRadius: '8px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: '8px', whiteSpace: 'nowrap' }}>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', lineHeight: 1 }}>42</span>
                    <span style={{ fontSize: '9.5px', fontWeight: 700, color: 'var(--green)' }}>↑ 12%</span>
                  </span>
                </div>
                <div style={{ background: 'var(--tint)', border: '1px solid var(--line)', borderRadius: '12px', padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: '7px', minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--ink2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Avg. productivity</span>
                    <span style={{ flex: 'none', width: '26px', height: '26px', borderRadius: '8px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m22 7-8.5 8.5-5-5L2 17" />
                        <path d="M16 7h6v6" />
                      </svg>
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: '8px', whiteSpace: 'nowrap' }}>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', lineHeight: 1 }}>86%</span>
                    <span style={{ fontSize: '9.5px', fontWeight: 700, color: 'var(--green)' }}>↑ 8%</span>
                  </span>
                </div>
                <div style={{ background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.15)', borderRadius: '12px', padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: '7px', minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--ink2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Security alerts</span>
                    <span style={{ flex: 'none', width: '26px', height: '26px', borderRadius: '8px', background: 'rgba(220,38,38,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        <path d="M12 8v4M12 16h.01" />
                      </svg>
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: '8px', whiteSpace: 'nowrap' }}>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', lineHeight: 1, animation: 'rd-count-glow 2.2s infinite' }}>3</span>
                    <span style={{ fontSize: '9.5px', fontWeight: 700, color: '#DC2626' }}>View all</span>
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {/* Team productivity bars */}
                <div style={{ border: '1px solid var(--line)', borderRadius: '12px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 700, fontSize: '12.5px' }}>Team productivity</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '10px', fontWeight: 600, color: 'var(--ink2)', border: '1px solid var(--line2)', padding: '4px 9px', borderRadius: '7px', whiteSpace: 'nowrap' }}>
                      Today{' '}
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', height: '82px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: '8.5px', fontWeight: 600, color: 'var(--ink3)', textAlign: 'right', paddingBottom: '2px' }}>
                      <span>100%</span>
                      <span>75%</span>
                      <span>50%</span>
                      <span>25%</span>
                      <span>0%</span>
                    </div>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
                      {heroBars.map((bar, i) => (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                          <div style={{ borderRadius: '6px', background: bar.color, height: bar.h, transformOrigin: 'bottom', animation: 'rd-bar 3.4s ease-in-out infinite', animationDelay: bar.delay }} />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: 600, color: 'var(--ink3)', paddingLeft: '26px' }}>
                    <span>9 AM</span>
                    <span>11 AM</span>
                    <span>1 PM</span>
                    <span>3 PM</span>
                    <span>5 PM</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '8px', alignItems: 'center', borderTop: '1px solid var(--line)', paddingTop: '10px' }}>
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, alignItems: 'center' }}>
                      <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '14px' }}>7h 12m</span>
                      <span style={{ fontSize: '9.5px', fontWeight: 600, color: 'var(--ink3)' }}>Active time</span>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, alignItems: 'center', borderLeft: '1px solid var(--line)' }}>
                      <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '14px' }}>48m</span>
                      <span style={{ fontSize: '9.5px', fontWeight: 600, color: 'var(--ink3)' }}>Idle time</span>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, alignItems: 'center', borderLeft: '1px solid var(--line)' }}>
                      <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '14px' }}>86%</span>
                      <span style={{ fontSize: '9.5px', fontWeight: 600, color: 'var(--ink3)' }}>Productive</span>
                    </span>
                    <span style={{ width: '28px', height: '28px', borderRadius: '8px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m22 7-8.5 8.5-5-5L2 17" />
                        <path d="M16 7h6v6" />
                      </svg>
                    </span>
                  </div>
                </div>

                {/* Top used apps */}
                <div style={{ border: '1px solid var(--line)', borderRadius: '12px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '9px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '12.5px', whiteSpace: 'nowrap' }}>Top used apps</span>
                    <span style={{ fontSize: '9.5px', fontWeight: 700, color: 'var(--blue)', whiteSpace: 'nowrap' }}>View all</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: phone ? 'minmax(0,1fr)' : '1fr 1fr', gap: '8px 28px' }}>
                    {topApps.map((app, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ flex: 'none', width: '20px', height: '20px', borderRadius: '5px', background: app.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFFFFF', fontSize: '9px', fontWeight: 700 }}>
                          {app.letter}
                        </span>
                        <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
                          <span style={{ display: 'flex', justifyContent: 'space-between', gap: '6px', fontSize: '10px', whiteSpace: 'nowrap' }}>
                            <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.name}</span>
                            <span style={{ fontWeight: 600, color: 'var(--ink3)' }}>{app.time}</span>
                          </span>
                          <span style={{ height: '3px', borderRadius: '2px', background: 'var(--tint)', overflow: 'hidden', display: 'block' }}>
                            <span style={{ display: 'block', height: '100%', borderRadius: '2px', background: 'var(--blue)', width: app.w, transformOrigin: 'left', animation: 'rd-app-fill 6s ease-in-out infinite' }} />
                          </span>
                        </span>
                        <span style={{ flex: 'none', fontSize: '9.5px', fontWeight: 700, color: 'var(--ink2)' }}>{app.pct}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- FEATURES ---------- */}
      <section id="features" style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: phone ? '90px 20px 70px' : '90px 40px 70px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '18px', textAlign: 'center', marginBottom: '56px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.12em', color: '#0D9488', background: 'var(--blue-soft)', padding: '8px 18px', borderRadius: '999px' }}>
              ● ONE PLATFORM. COMPLETE VISIBILITY.
            </span>
            <h2 style={{ margin: 0, fontSize: 'clamp(32px,3.4vw,50px)', lineHeight: 1.15, letterSpacing: '-0.02em', fontWeight: 700 }}>
              Everything you need to manage
              <br />
              <span style={{ color: 'var(--blue)' }}>productivity, visibility and security.</span>
            </h2>
            <p style={{ margin: 0, fontSize: '17px', lineHeight: 1.7, color: 'var(--ink2)', maxWidth: '540px', textWrap: 'pretty' }}>
              Rudrans brings all the essential tools together in one platform so you can focus on what truly matters.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,320px),1fr))', gap: '24px' }}>
            {/* Card 1 — Visibility */}
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '22px', display: 'flex', flexDirection: 'column', gap: 0, boxShadow: '0 10px 30px rgba(13,38,84,0.05)' }}>
              <span style={{ width: '48px', height: '48px', borderRadius: '13px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </span>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', marginBottom: '8px' }}>Visibility</span>
              <p style={{ margin: '0 0 12px', fontSize: '14px', lineHeight: 1.55, color: 'var(--ink2)', textWrap: 'pretty' }}>See what's happening in real-time across your organization.</p>
              <span style={{ height: '1px', background: 'var(--line)', marginBottom: '12px' }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: '9px', marginBottom: '16px' }}>
                <FeatItem>Live screen monitoring</FeatItem>
                <FeatItem>Application &amp; website activity</FeatItem>
                <FeatItem>Activity timeline &amp; history</FeatItem>
                <FeatItem>Employee presence</FeatItem>
              </span>
              <span style={{ marginTop: 'auto' }}>
                <span style={{ position: 'relative', display: 'block', borderRadius: '12px', overflow: 'hidden', background: 'linear-gradient(150deg,#04211E,#0A332F 60%,#0D453F)', boxShadow: '0 14px 32px rgba(4,33,30,0.35)', aspectRatio: '16/7' }}>
                  <span style={{ position: 'absolute', inset: '10% 8%', borderRadius: '8px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', overflow: 'hidden' }}>
                    <span style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '18%', background: 'rgba(255,255,255,0.07)', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', gap: '4px', padding: '0 8px' }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#F87171' }} />
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#FBBF24' }} />
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#34D399' }} />
                      <span style={{ marginLeft: '8px', width: '34%', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.2)' }} />
                    </span>
                    <span style={{ position: 'absolute', left: 0, top: '18%', bottom: 0, width: '20%', borderRight: '1px solid rgba(255,255,255,0.1)', display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 7px' }}>
                      <span style={{ height: '4px', width: '80%', borderRadius: '2px', background: 'rgba(45,212,191,0.6)' }} />
                      <span style={{ height: '4px', width: '65%', borderRadius: '2px', background: 'rgba(255,255,255,0.16)' }} />
                      <span style={{ height: '4px', width: '72%', borderRadius: '2px', background: 'rgba(255,255,255,0.16)' }} />
                      <span style={{ height: '4px', width: '58%', borderRadius: '2px', background: 'rgba(255,255,255,0.16)' }} />
                    </span>
                    <span style={{ position: 'absolute', left: '24%', top: '28%', width: '44%', height: '5px', borderRadius: '2px', background: 'rgba(255,255,255,0.25)', animation: 'rd-typing 3.2s ease-in-out infinite' }} />
                    <span style={{ position: 'absolute', left: '24%', top: '42%', width: '60%', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.12)' }} />
                    <span style={{ position: 'absolute', left: '24%', top: '52%', width: '52%', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.12)' }} />
                    <span style={{ position: 'absolute', left: '24%', top: '62%', width: '56%', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.12)' }} />
                    <span style={{ position: 'absolute', left: '46%', top: '48%', zIndex: 2, animation: 'rd-cursor 5s ease-in-out infinite' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="#FFFFFF" stroke="#04211E" strokeWidth="1.4">
                        <path d="M4 2l16 8-7 2-2 7z" />
                      </svg>
                    </span>
                  </span>
                  <span style={{ position: 'absolute', top: '7px', right: '8px', display: 'inline-flex', alignItems: 'center', gap: '5px', background: '#0D9488', color: '#FFFFFF', fontSize: '9px', fontWeight: 800, borderRadius: '999px', padding: '3px 9px', letterSpacing: '0.08em' }}>
                    <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#FFFFFF', animation: 'rd-pulse 1.4s infinite' }} />
                    LIVE VIEW
                  </span>
                  <span style={{ position: 'absolute', left: '8px', bottom: '7px', display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '9px', fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>
                    <span style={{ width: '14px', height: '14px', borderRadius: '50%', background: '#DB2777', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '7px', fontWeight: 800, color: '#FFFFFF' }}>PS</span>
                    Priya&#8217;s desktop
                  </span>
                </span>
              </span>
            </div>

            {/* Card 2 — Productivity */}
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '22px', display: 'flex', flexDirection: 'column', gap: 0, boxShadow: '0 10px 30px rgba(13,38,84,0.05)' }}>
              <span style={{ width: '48px', height: '48px', borderRadius: '13px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="m7 14 4-4 3 3 5-6" />
                  <path d="M16 7h3v3" />
                </svg>
              </span>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', marginBottom: '8px' }}>Productivity</span>
              <p style={{ margin: '0 0 12px', fontSize: '14px', lineHeight: 1.55, color: 'var(--ink2)', textWrap: 'pretty' }}>Understand how work gets done and drive high performance.</p>
              <span style={{ height: '1px', background: 'var(--line)', marginBottom: '12px' }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: '9px', marginBottom: '16px' }}>
                <FeatItem>Active &amp; idle time tracking</FeatItem>
                <FeatItem>App usage &amp; time spent</FeatItem>
                <FeatItem>Productivity scoring</FeatItem>
                <FeatItem>Team &amp; employee insights</FeatItem>
              </span>
              <span style={{ marginTop: 'auto' }}>
                <span style={{ position: 'relative', display: 'block', borderRadius: '12px', overflow: 'hidden', background: 'linear-gradient(150deg,#04211E,#0A332F 60%,#0D453F)', boxShadow: '0 14px 32px rgba(4,33,30,0.35)', aspectRatio: '16/7' }}>
                  <svg viewBox="0 0 320 140" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                    <defs>
                      <linearGradient id="rd-area-card" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2DD4BF" stopOpacity="0.35" />
                        <stop offset="100%" stopColor="#2DD4BF" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <g stroke="rgba(255,255,255,0.07)" strokeWidth="1">
                      <line x1="0" y1="35" x2="320" y2="35" />
                      <line x1="0" y1="70" x2="320" y2="70" />
                      <line x1="0" y1="105" x2="320" y2="105" />
                    </g>
                    <path d="M0,112 C40,108 62,92 92,88 C122,84 138,96 168,84 C198,72 214,52 244,46 C268,41 292,34 316,28 L316,140 L0,140 Z" fill="url(#rd-area-card)">
                      <animate attributeName="opacity" values="0;0.3;1;1;0" keyTimes="0;0.18;0.5;0.86;1" dur="6s" repeatCount="indefinite" />
                    </path>
                    <path
                      d="M0,112 C40,108 62,92 92,88 C122,84 138,96 168,84 C198,72 214,52 244,46 C268,41 292,34 316,28"
                      fill="none"
                      stroke="#2DD4BF"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeDasharray="340"
                      strokeDashoffset="340"
                    >
                      <animate attributeName="stroke-dashoffset" values="340;0;0;340" keyTimes="0;0.5;0.86;1" dur="6s" calcMode="spline" keySplines="0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" repeatCount="indefinite" />
                    </path>
                    <circle cx="316" cy="28" r="4" fill="#5EEAD4">
                      <animate attributeName="r" values="3.5;6;3.5" dur="1.8s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.45;0.53;0.86;1" dur="6s" repeatCount="indefinite" />
                    </circle>
                  </svg>
                  <span style={{ position: 'absolute', top: '8px', left: '10px', display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                    <span style={{ fontSize: '9px', fontWeight: 700, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.1em' }}>PRODUCTIVITY SCORE</span>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', color: '#FFFFFF' }}>
                      86<span style={{ fontSize: '11px', color: '#5EEAD4' }}> / 100</span>
                    </span>
                  </span>
                  <span style={{ position: 'absolute', top: '10px', right: '8px', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10px', fontWeight: 800, color: '#5EEAD4', background: 'rgba(45,212,191,0.14)', borderRadius: '999px', padding: '3px 9px' }}>
                    ▲ 14% this week
                  </span>
                </span>
              </span>
            </div>

            {/* Card 3 — Security */}
            <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '22px', display: 'flex', flexDirection: 'column', gap: 0, boxShadow: '0 10px 30px rgba(13,38,84,0.05)' }}>
              <span style={{ width: '48px', height: '48px', borderRadius: '13px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M12 8v4" />
                  <circle cx="12" cy="15.5" r="0.5" fill="#0D9488" />
                </svg>
              </span>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', marginBottom: '8px' }}>Security</span>
              <p style={{ margin: '0 0 12px', fontSize: '14px', lineHeight: 1.55, color: 'var(--ink2)', textWrap: 'pretty' }}>Protect your data and devices with powerful controls.</p>
              <span style={{ height: '1px', background: 'var(--line)', marginBottom: '12px' }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: '9px', marginBottom: '16px' }}>
                <FeatItem>DLP &amp; data leak prevention</FeatItem>
                <FeatItem>USB &amp; device monitoring</FeatItem>
                <FeatItem>File activity tracking</FeatItem>
                <FeatItem>Smart alerts &amp; notifications</FeatItem>
              </span>
              <span style={{ marginTop: 'auto' }}>
                <span style={{ position: 'relative', display: 'block', borderRadius: '12px', overflow: 'hidden', background: 'linear-gradient(150deg,#04211E,#0A332F 60%,#0D453F)', boxShadow: '0 14px 32px rgba(4,33,30,0.35)', aspectRatio: '16/7' }}>
                  <span style={{ position: 'absolute', inset: '10% 8%', borderRadius: '8px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', overflow: 'hidden' }}>
                    <span style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '18%', background: 'rgba(255,255,255,0.07)', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', gap: '6px', padding: '0 8px' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="4" width="20" height="16" rx="2" />
                        <path d="m22 7-10 6L2 7" />
                      </svg>
                      <span style={{ fontSize: '8.5px', fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>New message</span>
                    </span>
                    <span style={{ position: 'absolute', left: '8px', right: '8px', top: '24%', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.45)', fontWeight: 600 }}>To:</span>
                      <span style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.1)', borderRadius: '999px', padding: '2px 7px' }}>personal-mail@gmail.com</span>
                    </span>
                    <span style={{ position: 'absolute', left: '8px', top: '42%', width: '52%', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.14)' }} />
                    <span style={{ position: 'absolute', left: '8px', top: '52%', width: '40%', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.14)' }} />
                    <span style={{ position: 'absolute', left: '8px', bottom: '9%', display: 'flex', alignItems: 'center', gap: '5px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: '6px', padding: '4px 8px' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5EEAD4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.57-8.57a4 4 0 1 1 5.66 5.66l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                      </svg>
                      <span style={{ fontSize: '8.5px', fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>salary-data.xlsx</span>
                      <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.5)' }}>2.4 MB</span>
                    </span>
                    <span style={{ position: 'absolute', inset: 0, background: 'rgba(4,33,30,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'rd-slide-in 5s ease 1.6s infinite both' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#3B0D0D', border: '1px solid rgba(248,113,113,0.5)', borderRadius: '9px', padding: '8px 12px', boxShadow: '0 10px 26px rgba(0,0,0,0.4)' }}>
                        <span style={{ flex: 'none', width: '22px', height: '22px', borderRadius: '50%', background: 'rgba(248,113,113,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#F87171" strokeWidth="2.4" strokeLinecap="round">
                            <circle cx="12" cy="12" r="9" />
                            <path d="M5.6 5.6l12.8 12.8" />
                          </svg>
                        </span>
                        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
                          <span style={{ fontSize: '9.5px', fontWeight: 800, color: '#FECACA' }}>Sending blocked</span>
                          <span style={{ fontSize: '8.5px', color: 'rgba(254,202,202,0.7)' }}>Confidential file · DLP policy</span>
                        </span>
                      </span>
                    </span>
                  </span>
                  <span style={{ position: 'absolute', top: '7px', right: '8px', display: 'inline-flex', alignItems: 'center', gap: '5px', background: 'rgba(220,38,38,0.85)', color: '#FFFFFF', fontSize: '9px', fontWeight: 800, borderRadius: '999px', padding: '3px 9px', letterSpacing: '0.08em' }}>
                    <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#FFFFFF', animation: 'rd-pulse 1.4s infinite' }} />
                    DLP ACTIVE
                  </span>
                  <span style={{ position: 'absolute', left: '8px', bottom: '7px', display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '9px', fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5EEAD4" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    Admin notified instantly
                  </span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- HOW IT WORKS ---------- */}
      <section id="how" style={{ maxWidth: '1400px', margin: '0 auto', padding: phone ? '80px 20px' : '80px 40px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '56px', alignItems: 'flex-start', ...(tablet ? { flexDirection: 'column' } : {}) }}>
          <div style={{ flex: tablet ? '0 0 auto' : '1 1 340px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '18px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--blue)', background: 'var(--blue-soft)', padding: '7px 16px', borderRadius: '999px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--blue)' }} />
              HOW IT WORKS
            </span>
            <h2 style={{ margin: 0, fontSize: 'clamp(30px,2.8vw,42px)', lineHeight: 1.15, letterSpacing: '-0.02em', fontWeight: 700 }}>
              One agent.
              <br />
              <span style={{ color: 'var(--blue)' }}>Everything connected.</span>
            </h2>
            <p style={{ margin: 0, fontSize: '16px', lineHeight: 1.65, color: 'var(--ink2)', textWrap: 'pretty' }}>
              Rudrans runs as a lightweight agent on employee devices and brings all your workforce data into one secure workspace.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
              {[
                { icon: (<><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M12 7v6M9 10l3 3 3-3" /></>), num: '01', title: 'Install the agent', sub: 'Deploy on company devices in minutes.', border: true },
                { icon: (<><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /><path d="m7 12 3-3 2 2 4-4" /></>), num: '02', title: 'Activity is captured', sub: 'Apps, websites, screens, device events and working time.', border: true },
                { icon: (<><path d="M17.5 19H9a5 5 0 1 1 .8-9.9A7 7 0 1 1 17.5 19z" /><path d="M12 12v4M10 14l2-2 2 2" /></>), num: '03', title: 'Securely processed', sub: 'Activity becomes productivity insights and security signals.', border: true },
                { icon: (<path d="M18 20V10M12 20V4M6 20v-6" />), num: '04', title: 'Admin takes action', sub: 'Monitor, investigate and manage from one dashboard.', border: false },
              ].map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', padding: '16px 0', borderBottom: s.border ? '1px solid var(--line)' : undefined }}>
                  <span style={{ flex: 'none', width: '50px', height: '50px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {s.icon}
                    </svg>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                      <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '14px', color: 'var(--blue)' }}>{s.num}</span>
                      <span style={{ fontWeight: 700, fontSize: '16px' }}>{s.title}</span>
                    </span>
                    <span style={{ fontSize: '13.5px', lineHeight: 1.55, color: 'var(--ink2)' }}>{s.sub}</span>
                  </span>
                </div>
              ))}
            </div>
            <HoverA
              href="#pricing"
              base={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                background: 'var(--card)',
                border: '1.5px solid var(--line2)',
                color: 'var(--ink)',
                fontWeight: 700,
                fontSize: '14.5px',
                padding: '13px 24px',
                borderRadius: '12px',
                transition: 'all 0.25s ease',
              }}
              hover={{ border: '1.5px solid var(--blue)', color: 'var(--blue)' }}
            >
              Learn more about how it works <span style={{ fontWeight: 400 }}>→</span>
            </HoverA>
          </div>
          <div style={{ flex: tablet ? '0 0 auto' : '2.1 1 620px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0, display: 'flex', flexDirection: 'column', gap: '22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img
                src="/rudrans/how-diagram-home.webp" width="1536" height="1024" loading="lazy" decoding="async"
                alt="How Rudrans works — devices send data through the Rudrans agent to the Rudrans cloud, protected by a security layer, powering real-time insights in the admin dashboard"
                style={{ width: '100%', maxWidth: '820px', height: 'auto' }}
              />
            </div>
            <div style={{ background: 'var(--tint)', border: '1px solid var(--line)', borderRadius: '16px', padding: '20px 24px', display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '18px', ...(phone ? { gridTemplateColumns: 'minmax(0,1fr)' } : tablet ? { gridTemplateColumns: '1fr 1fr' } : {}) }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 8c-5 0-10 2-11 8 3-2 5-2 7-2-1 2-1 4-3 6 7-1 11-5 11-11 0-.5 0-1-.2-1.4A8 8 0 0 0 17 8z" />
                </svg>
                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
                  <span style={{ fontWeight: 700, fontSize: '13.5px' }}>Lightweight agent</span>
                  <span style={{ fontSize: '12px', color: 'var(--ink3)' }}>Minimal performance impact</span>
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '12px', ...(tablet ? {} : { borderLeft: '1px solid var(--line2)', paddingLeft: '18px' }) }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 6h16M4 10h16M4 14h10M4 18h7" />
                </svg>
                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
                  <span style={{ fontWeight: 700, fontSize: '13.5px' }}>Real-time data</span>
                  <span style={{ fontSize: '12px', color: 'var(--ink3)' }}>Live activity across all devices</span>
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '12px', ...(tablet ? {} : { borderLeft: '1px solid var(--line2)', paddingLeft: '18px' }) }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
                  <span style={{ fontWeight: 700, fontSize: '13.5px' }}>Secure by design</span>
                  <span style={{ fontSize: '12px', color: 'var(--ink3)' }}>Encrypted and access-controlled</span>
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '12px', ...(tablet ? {} : { borderLeft: '1px solid var(--line2)', paddingLeft: '18px' }) }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
                  <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
                </svg>
                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
                  <span style={{ fontWeight: 700, fontSize: '13.5px' }}>Ready in minutes</span>
                  <span style={{ fontSize: '12px', color: 'var(--ink3)' }}>Quick company-wide rollout</span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- INSIGHTS (dark) ---------- */}
      <section id="insights" style={{ background: 'linear-gradient(120deg,#04211E,#0A332F 55%,#0D453F)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: phone ? '90px 20px' : '90px 40px', display: 'flex', flexWrap: 'wrap', gap: '56px', alignItems: 'center', ...(tablet ? { flexDirection: 'column' } : {}) }}>
          <div style={{ flex: tablet ? '0 0 auto' : '1 1 440px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '22px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '11.5px', fontWeight: 700, letterSpacing: '0.16em', color: '#5EEAD4', background: 'rgba(94,234,212,0.1)', border: '1px solid rgba(94,234,212,0.25)', padding: '8px 18px', borderRadius: '999px' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="#5EEAD4">
                <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
              </svg>
              GLOBAL INTELLIGENCE
            </span>
            <h2 style={{ margin: 0, fontSize: 'clamp(34px,3.2vw,52px)', lineHeight: 1.12, letterSpacing: '-0.025em', fontWeight: 700, color: '#FFFFFF' }}>
              One Platform.
              <br />
              <span style={{ color: '#2DD4BF' }}>Worldwide Visibility.</span>
            </h2>
            <p style={{ margin: 0, fontSize: '17px', lineHeight: 1.7, color: 'rgba(255,255,255,0.65)', maxWidth: '480px', textWrap: 'pretty' }}>
              Monitor, analyze and protect your workforce across every location — all from a single, unified platform.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,240px),1fr))', gap: '16px', width: '100%', paddingTop: '6px' }}>
              {[
                { icon: (<><circle cx="12" cy="12" r="9" /><path d="M2 12h20M12 3a15.3 15.3 0 0 1 0 18 15.3 15.3 0 0 1 0-18z" /></>), title: 'Multi-Location Support', sub: 'Manage teams across cities, countries and time zones.' },
                { icon: (<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="m16 11 2 2 4-4" /></>), title: 'Role-Based Access', sub: 'Right data, right people, right time.' },
                { icon: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>), title: 'Real-Time Insights', sub: 'Spot trends and act before issues grow.' },
                { icon: (<><path d="m22 7-8.5 8.5-5-5L2 17" /><path d="M16 7h6v6" /></>), title: 'Business Growth', sub: 'Make data-driven decisions with confidence.' },
              ].map((c, i) => (
                <div key={i} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px', padding: '22px', display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                  <span style={{ flex: 'none', width: '52px', height: '52px', borderRadius: '14px', background: 'rgba(45,212,191,0.12)', border: '1px solid rgba(45,212,191,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2DD4BF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {c.icon}
                    </svg>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '4px', lineHeight: 1.5 }}>
                    <span style={{ fontWeight: 700, fontSize: '15.5px', color: '#FFFFFF' }}>{c.title}</span>
                    <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)' }}>{c.sub}</span>
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap', paddingTop: '10px' }}>
              <HoverLink
                to="/contact"
                base={{ display: 'inline-flex', alignItems: 'center', gap: '9px', background: '#0D9488', color: '#FFFFFF', fontWeight: 700, fontSize: '15px', padding: '15px 30px', borderRadius: '12px', transition: 'all 0.25s ease' }}
                hover={{ background: '#14B8A6', color: '#FFFFFF', transform: 'translateY(-2px)' }}
              >
                See It in Action <span style={{ fontWeight: 400 }}>→</span>
              </HoverLink>
            </div>
          </div>
          <div style={{ flex: tablet ? '0 0 auto' : '1.15 1 480px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0 }}>
            <div style={{ position: 'relative', width: '100%', aspectRatio: '1400/1128', background: '#FFFFFF', borderRadius: '22px', border: '1px solid rgba(94,234,212,0.3)', boxShadow: '0 0 0 8px rgba(45,212,191,0.06),0 34px 70px rgba(0,0,0,0.45)', overflow: 'hidden' }}>
              <img src="/rudrans/global-visibility.webp" width="1394" height="1128" loading="lazy" decoding="async" alt="Global visibility" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: '20px' }} />
            </div>
          </div>
        </div>
      </section>

      {/* ---------- TRENDS ---------- */}
      <section id="trends" style={{ background: 'var(--bg)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: phone ? '80px 20px' : '80px 40px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center', marginBottom: '14px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--blue)', background: 'var(--blue-soft)', padding: '7px 16px', borderRadius: '999px' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 7-8.5 8.5-5-5L2 17" />
                <path d="M16 7h6v6" />
              </svg>
              WORKFORCE INSIGHTS
            </span>
            <h2 style={{ margin: 0, fontSize: 'clamp(30px,2.8vw,42px)', lineHeight: 1.18, letterSpacing: '-0.02em', fontWeight: 700 }}>
              Understand trends.
              <br />
              <span style={{ color: 'var(--blue)' }}>Make better decisions.</span>
            </h2>
            <p style={{ margin: 0, fontSize: '16px', lineHeight: 1.65, color: 'var(--ink2)', maxWidth: '520px', textWrap: 'pretty' }}>
              Rudrans turns workforce data into meaningful insights so you can improve productivity and performance.
            </p>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '22px', alignItems: 'stretch', ...(tablet ? { flexDirection: 'column' } : {}) }}>
            <div style={{ flex: tablet ? '0 0 auto' : '1.9 1 560px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0, display: 'flex', flexDirection: 'column', gap: '22px' }}>
              <div style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '24px 26px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', fontWeight: 700, letterSpacing: '0.06em' }}>
                    TEAM PRODUCTIVITY TREND{' '}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 8h.01M12 12v4" />
                    </svg>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', fontWeight: 600, color: 'var(--ink2)', border: '1px solid var(--line2)', padding: '9px 14px', borderRadius: '10px', whiteSpace: 'nowrap' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2" />
                      <path d="M16 2v4M8 2v4M3 10h18" />
                    </svg>
                    This Week{' '}
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </span>
                </div>
                <span style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', fontWeight: 600, color: 'var(--ink2)' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--blue)' }} />
                  Productivity Score (%)
                </span>
                <svg viewBox="0 0 720 265" style={{ width: '100%', height: 'auto', display: 'block', flex: 1, minHeight: 0, margin: 'auto 0' }}>
                  <defs>
                    <linearGradient id="rd-area-trend" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0D9488" stopOpacity="0.22" />
                      <stop offset="100%" stopColor="#0D9488" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                  <g stroke="var(--line2)" strokeWidth="1" strokeDasharray="4 5">
                    <line x1="55" y1="15" x2="705" y2="15" />
                    <line x1="55" y1="69" x2="705" y2="69" />
                    <line x1="55" y1="123" x2="705" y2="123" />
                    <line x1="55" y1="177" x2="705" y2="177" />
                    <line x1="55" y1="231" x2="705" y2="231" />
                  </g>
                  <g fill="var(--ink3)" fontSize="12" fontFamily="IBM Plex Sans,sans-serif" textAnchor="end">
                    <text x="46" y="19">100%</text>
                    <text x="46" y="73">90%</text>
                    <text x="46" y="127">80%</text>
                    <text x="46" y="181">70%</text>
                    <text x="46" y="235">60%</text>
                  </g>
                  <path d="M75,144 L179,111 L283,79 L387,101 L491,58 L595,133 L699,166 L699,231 L75,231 Z" fill="url(#rd-area-trend)">
                    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.42;0.86;1" dur="8s" repeatCount="indefinite" />
                  </path>
                  <path d="M75,144 L179,111 L283,79 L387,101 L491,58 L595,133 L699,166" fill="none" stroke="#0D9488" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="700" strokeDashoffset="700">
                    <animate attributeName="stroke-dashoffset" values="700;0;0;700" keyTimes="0;0.42;0.86;1" dur="8s" calcMode="spline" keySplines="0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" repeatCount="indefinite" />
                  </path>
                  <g fill="#0D9488" stroke="var(--card)" strokeWidth="2.5">
                    <circle cx="75" cy="144" r="5.5" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.06;0.10;0.86;1" dur="8s" repeatCount="indefinite" /></circle>
                    <circle cx="179" cy="111" r="5.5" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.12;0.16;0.86;1" dur="8s" repeatCount="indefinite" /></circle>
                    <circle cx="283" cy="79" r="5.5" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.18;0.22;0.86;1" dur="8s" repeatCount="indefinite" /></circle>
                    <circle cx="387" cy="101" r="5.5" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.24;0.28;0.86;1" dur="8s" repeatCount="indefinite" /></circle>
                    <circle cx="491" cy="58" r="5.5" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.3;0.34;0.86;1" dur="8s" repeatCount="indefinite" /></circle>
                    <circle cx="595" cy="133" r="5.5" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.36;0.40;0.86;1" dur="8s" repeatCount="indefinite" /></circle>
                    <circle cx="699" cy="166" r="5.5" opacity="0"><animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.42;0.46;0.86;1" dur="8s" repeatCount="indefinite" /></circle>
                  </g>
                  <g fill="var(--ink)" fontSize="13" fontWeight="700" fontFamily="IBM Plex Sans,sans-serif" textAnchor="middle">
                    <text x="75" y="126" opacity="0">76%<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.06;0.11;0.86;1" dur="8s" repeatCount="indefinite" /></text>
                    <text x="179" y="93" opacity="0">82%<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.12;0.17;0.86;1" dur="8s" repeatCount="indefinite" /></text>
                    <text x="283" y="61" opacity="0">88%<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.18;0.23;0.86;1" dur="8s" repeatCount="indefinite" /></text>
                    <text x="387" y="83" opacity="0">84%<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.24;0.29;0.86;1" dur="8s" repeatCount="indefinite" /></text>
                    <text x="491" y="40" opacity="0">92%<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.3;0.35;0.86;1" dur="8s" repeatCount="indefinite" /></text>
                    <text x="595" y="115" opacity="0">78%<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.36;0.41;0.86;1" dur="8s" repeatCount="indefinite" /></text>
                    <text x="699" y="148" opacity="0">72%<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.42;0.47;0.86;1" dur="8s" repeatCount="indefinite" /></text>
                  </g>
                  <g fill="var(--ink2)" fontSize="13" fontWeight="600" fontFamily="IBM Plex Sans,sans-serif" textAnchor="middle">
                    <text x="75" y="258">Mon</text>
                    <text x="179" y="258">Tue</text>
                    <text x="283" y="258">Wed</text>
                    <text x="387" y="258">Thu</text>
                    <text x="491" y="258">Fri</text>
                    <text x="595" y="258">Sat</text>
                    <text x="699" y="258">Sun</text>
                  </g>
                </svg>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--blue)' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
                    <circle cx="12" cy="12" r="4" />
                  </svg>
                  AI-GENERATED INSIGHTS
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))', gap: '14px' }}>
                  <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '14px', padding: '18px', display: 'flex', alignItems: 'flex-start', gap: '13px' }}>
                    <span style={{ flex: 'none', width: '44px', height: '44px', borderRadius: '50%', background: 'var(--green-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m22 7-8.5 8.5-5-5L2 17" />
                        <path d="M16 7h6v6" />
                      </svg>
                    </span>
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontWeight: 700, fontSize: '14.5px' }}>Engineering</span>
                      <span style={{ fontSize: '12.5px', lineHeight: 1.55, color: 'var(--ink2)' }}>Productivity increased 12% this week.</span>
                      <span style={{ alignSelf: 'flex-end', fontSize: '11px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-soft)', padding: '4px 10px', borderRadius: '999px', marginTop: '4px', animation: 'rd-count-glow 3s infinite' }}>↑ 12%</span>
                    </span>
                  </div>
                  <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '14px', padding: '18px', display: 'flex', alignItems: 'flex-start', gap: '13px' }}>
                    <span style={{ flex: 'none', width: '44px', height: '44px', borderRadius: '50%', background: 'var(--amber-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" />
                      </svg>
                    </span>
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontWeight: 700, fontSize: '14.5px' }}>Support</span>
                      <span style={{ fontSize: '12.5px', lineHeight: 1.55, color: 'var(--ink2)' }}>Peak workload occurs between 10 AM – 1 PM.</span>
                      <span style={{ alignSelf: 'flex-end', fontSize: '11px', fontWeight: 700, color: 'var(--amber)', background: 'var(--amber-soft)', padding: '4px 10px', borderRadius: '999px', marginTop: '4px', animation: 'rd-count-glow 3s 0.7s infinite' }}>Peak Hours</span>
                    </span>
                  </div>
                  <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '14px', padding: '18px', display: 'flex', alignItems: 'flex-start', gap: '13px' }}>
                    <span style={{ flex: 'none', width: '44px', height: '44px', borderRadius: '50%', background: 'rgba(124,58,237,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 3v18h18" />
                        <path d="m7 14 4-4 3 3 5-6" />
                      </svg>
                    </span>
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontWeight: 700, fontSize: '14.5px' }}>Sales</span>
                      <span style={{ fontSize: '12.5px', lineHeight: 1.55, color: 'var(--ink2)' }}>After-hours activity dropped 18%.</span>
                      <span style={{ alignSelf: 'flex-end', fontSize: '11px', fontWeight: 700, color: '#7C3AED', background: 'rgba(124,58,237,0.1)', padding: '4px 10px', borderRadius: '999px', marginTop: '4px', animation: 'rd-count-glow 3s 1.4s infinite' }}>↓ 18%</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div style={{ flex: tablet ? '0 0 auto' : '1 1 320px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0, display: 'flex', flexDirection: 'column', gap: '22px' }}>
              <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '24px 26px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <span style={{ fontSize: '13.5px', fontWeight: 700, letterSpacing: '0.06em' }}>KEY METRICS (THIS WEEK)</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '22px 16px' }}>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center' }}>
                    <span style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m22 7-8.5 8.5-5-5L2 17" />
                        <path d="M16 7h6v6" />
                      </svg>
                    </span>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '24px', lineHeight: 1 }}>87%</span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink2)' }}>Avg Productivity</span>
                    <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-soft)', padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap' }}>↑ 8% vs last week</span>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center', borderLeft: '1px solid var(--line)', paddingLeft: '16px' }}>
                    <span style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(124,58,237,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" />
                      </svg>
                    </span>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '24px', lineHeight: 1 }}>42.6h</span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink2)' }}>Total Focus Time</span>
                    <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-soft)', padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap' }}>↑ 6% vs last week</span>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center', borderTop: '1px solid var(--line)', paddingTop: '18px' }}>
                    <span style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'var(--amber-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="9" />
                        <circle cx="12" cy="12" r="5" />
                        <circle cx="12" cy="12" r="1.5" fill="var(--amber)" />
                      </svg>
                    </span>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '24px', lineHeight: 1 }}>91%</span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink2)' }}>Goal Achievement</span>
                    <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-soft)', padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap' }}>↑ 11% vs last week</span>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', textAlign: 'center', borderTop: '1px solid var(--line)', borderLeft: '1px solid var(--line)', paddingTop: '18px', paddingLeft: '16px' }}>
                    <span style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(2,132,199,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#0284C7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                    </span>
                    <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '24px', lineHeight: 1 }}>248</span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink2)' }}>Active Users</span>
                    <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-soft)', padding: '4px 10px', borderRadius: '999px', whiteSpace: 'nowrap' }}>↑ 7% vs last week</span>
                  </span>
                </div>
              </div>
              <div style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '24px 26px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
                <span style={{ fontSize: '13.5px', fontWeight: 700, letterSpacing: '0.06em' }}>PRODUCTIVITY BY DEPARTMENT</span>
                {deptRows.map((dp, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ flex: 'none', width: '32px', height: '32px', borderRadius: '9px', background: dp.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, color: dp.color }}>{dp.letter}</span>
                    <span style={{ flex: 'none', width: '88px', fontSize: '13px', fontWeight: 600 }}>{dp.name}</span>
                    <span style={{ flex: 1, height: '9px', borderRadius: '5px', background: 'var(--tint)', overflow: 'hidden' }}>
                      <span style={{ display: 'block', height: '100%', borderRadius: '5px', background: 'linear-gradient(90deg,#0D9488,#14B8A6)', width: dp.pct, transformOrigin: 'left', animation: 'rd-app-fill 6s ease-in-out infinite' }} />
                    </span>
                    <span style={{ flex: 'none', width: '38px', textAlign: 'right', fontSize: '13px', fontWeight: 700 }}>{dp.pct}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- PRICING ---------- */}
      {showPricing && (
        <section id="pricing" style={{ background: 'var(--bg2)' }}>
          <div style={{ maxWidth: '1400px', margin: '0 auto', padding: phone ? '90px 20px 0' : '90px 40px 0', display: 'flex', flexWrap: 'wrap', gap: '44px', alignItems: 'flex-start', ...(tablet ? { flexDirection: 'column' } : {}) }}>
            <div style={{ flex: tablet ? '0 0 auto' : '1 1 280px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '18px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--blue)', background: 'var(--blue-soft)', padding: '7px 16px', borderRadius: '999px' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                SIMPLE &amp; TRANSPARENT
              </span>
              <h2 style={{ margin: 0, fontSize: 'clamp(30px,2.8vw,42px)', lineHeight: 1.18, letterSpacing: '-0.02em', fontWeight: 700 }}>
                Plans that grow with <span style={{ color: 'var(--blue)' }}>your team.</span>
              </h2>
              <p style={{ margin: 0, fontSize: '16px', lineHeight: 1.65, color: 'var(--ink2)', textWrap: 'pretty' }}>Start small, scale fast. No hidden fees, cancel anytime.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', paddingTop: '8px' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <span style={{ flex: 'none', width: '44px', height: '44px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <path d="m9 12 2 2 4-4" />
                    </svg>
                  </span>
                  <span style={{ fontSize: '14.5px', fontWeight: 600, color: 'var(--ink)' }}>All core monitoring &amp; security features</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <span style={{ flex: 'none', width: '44px', height: '44px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.5 19H9a5 5 0 1 1 .8-9.9A7 7 0 1 1 17.5 19z" />
                    </svg>
                  </span>
                  <span style={{ fontSize: '14.5px', fontWeight: 600, color: 'var(--ink)' }}>Cloud dashboard. No infrastructure to manage</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <span style={{ flex: 'none', width: '44px', height: '44px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </span>
                  <span style={{ fontSize: '14.5px', fontWeight: 600, color: 'var(--ink)' }}>Unlimited admins</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  <span style={{ flex: 'none', width: '44px', height: '44px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                    </svg>
                  </span>
                  <span style={{ fontSize: '14.5px', fontWeight: 600, color: 'var(--ink)' }}>Priority support</span>
                </span>
              </div>
            </div>
            <div style={{ flex: tablet ? '0 0 auto' : '3.2 1 820px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0, display: 'flex', flexDirection: 'column', gap: '22px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '16px', alignItems: 'stretch', ...(phone ? { gridTemplateColumns: 'minmax(0,1fr)' } : tablet ? { gridTemplateColumns: '1fr 1fr' } : {}) }}>
                {plans.map((plan, i) => (
                  <div key={i} style={{ position: 'relative', background: 'var(--card)', border: plan.border, borderRadius: '18px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {plan.popular && (
                      <span style={{ background: 'linear-gradient(90deg,#0A332F,#0D9488)', color: '#FFFFFF', fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textAlign: 'center', padding: '8px' }}>MOST POPULAR</span>
                    )}
                    <div style={{ padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: '15px', flex: 1 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <h3 style={{ margin: 0, fontSize: '19px', fontWeight: 700 }}>{plan.name}</h3>
                        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: 'var(--ink2)' }}>{plan.tagline}</p>
                      </div>
                      {plan.custom && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '12px', minHeight: '64px' }}>
                          <span style={{ flex: 'none', width: '46px', height: '46px', borderRadius: '10px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M19 21V11l-4-2" />
                              <path d="M9 7h1M9 11h1M9 15h1" />
                            </svg>
                          </span>
                          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
                            <span style={{ fontWeight: 700, fontSize: '14.5px' }}>Custom pricing</span>
                            <span style={{ fontSize: '12px', color: 'var(--ink3)' }}>Tailored to your needs</span>
                          </span>
                        </span>
                      )}
                      {plan.hasPrice && (
                        <span style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', minHeight: '64px' }}>
                          <span style={{ display: 'flex', alignItems: 'baseline' }}>
                            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px' }}>₹</span>
                            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '40px', letterSpacing: '-0.02em', lineHeight: 1 }}>{plan.price}</span>
                          </span>
                          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4, paddingTop: '6px' }}>
                            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink2)' }}>per user / month</span>
                            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink3)' }}>billed annually</span>
                          </span>
                        </span>
                      )}
                      <HoverLink
                        to={plan.cta === 'Contact sales' ? '/contact' : '/signup'}
                        base={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontWeight: 700, fontSize: '14px', padding: '12px', borderRadius: '10px', background: plan.ctaBg, color: plan.ctaColor, border: plan.ctaBorder, transition: 'all 0.25s ease' }}
                        hover={{ transform: 'translateY(-2px)' }}
                      >
                        {plan.cta}
                      </HoverLink>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '11px', borderTop: '1px solid var(--line)', paddingTop: '16px' }}>
                        {plan.plusLabel && <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--ink)' }}>{plan.plusLabel}</span>}
                        {plan.feats.map((ft, j) => (
                          <span key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', fontSize: '13px', lineHeight: 1.45, color: 'var(--ink2)' }}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: '1px' }}>
                              <circle cx="12" cy="12" r="9" />
                              <path d="m8.5 12 2.5 2.5 4.5-5" />
                            </svg>
                            {ft}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '9px', fontSize: '14px', fontWeight: 600, color: 'var(--ink2)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
                All plans include 14-day free trial. No credit card required.
              </span>
            </div>

            {/* CTA banner */}
            {/* Full-bleed banner: calc(50% - 50vw) breaks out of the centered
                1400px container to the viewport edges on every device; the
                .rd-site overflow-x clip absorbs the scrollbar-width excess. */}
            <div style={{ flexBasis: 'auto', flexShrink: 0, width: '100vw', boxSizing: 'border-box', margin: '22px calc(50% - 50vw) 0', background: 'linear-gradient(120deg,#04211E,#0A332F 60%,#0D453F)', borderRadius: 0, padding: phone ? '32px 20px' : tablet ? '40px 32px' : '48px clamp(40px,8vw,120px)', display: 'flex', flexWrap: 'wrap', gap: tablet && !phone ? '52px' : '44px', alignItems: 'center', overflow: 'hidden', position: 'relative', ...(phone ? { flexDirection: 'column' as const } : {}) }}>
              <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(rgba(94,234,212,0.14) 1px,transparent 1px)', backgroundSize: '22px 22px', WebkitMaskImage: 'linear-gradient(115deg,transparent 45%,black)', maskImage: 'linear-gradient(115deg,transparent 45%,black)' }} />
              <div style={{ position: 'relative', flex: phone ? '0 0 auto' : tablet ? '1 1 0' : '1 1 380px', ...(phone ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0, display: 'flex', justifyContent: 'center' }}>
                <span style={{ position: 'relative', width: 'min(100%,420px)', marginBottom: phone ? '18px' : 0 }}>
                  <span style={{ display: 'block', background: '#FFFFFF', borderRadius: '12px', boxShadow: '0 30px 60px rgba(0,0,0,0.4)', overflow: 'hidden' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '1px solid #E3E9F2' }}>
                      <span style={{ width: '22px', height: '22px', borderRadius: '6px', background: 'linear-gradient(160deg,#14B8A6,#0D9488)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFFFFF', fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '11px' }}>R</span>
                      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
                        <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '10px', color: '#1B2333' }}>Rudrans</span>
                        <span style={{ fontSize: '6px', fontWeight: 600, letterSpacing: '0.1em', color: '#8A94A8' }}>WORKFORCE MONITORING</span>
                      </span>
                    </span>
                    <span style={{ display: 'grid', gridTemplateColumns: '74px 1fr', minHeight: '190px' }}>
                      <span style={{ borderRight: '1px solid #E3E9F2', background: '#F6F8FB', display: 'flex', flexDirection: 'column', gap: '7px', padding: '12px 10px' }}>
                        <span style={{ height: '6px', borderRadius: '3px', background: '#0D9488', opacity: 0.7 }} />
                        <span style={{ height: '6px', borderRadius: '3px', background: '#D3DDEB' }} />
                        <span style={{ height: '6px', borderRadius: '3px', background: '#D3DDEB' }} />
                        <span style={{ height: '6px', borderRadius: '3px', background: '#D3DDEB' }} />
                        <span style={{ height: '6px', borderRadius: '3px', background: '#D3DDEB' }} />
                        <span style={{ height: '6px', borderRadius: '3px', background: '#D3DDEB' }} />
                      </span>
                      <span style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <span style={{ fontSize: '9.5px', fontWeight: 700, color: '#1B2333' }}>Top active users</span>
                        {ctaUsers.map((u, i) => (
                          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #EEF2F7', paddingBottom: '6px' }}>
                            <span style={{ flex: 'none', width: '18px', height: '18px', borderRadius: '50%', background: u.bg, color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '7px', fontWeight: 700 }}>{u.init}</span>
                            <span style={{ flex: 1, fontSize: '8.5px', fontWeight: 700, color: '#1B2333' }}>{u.name}</span>
                            <span style={{ fontSize: '8.5px', fontWeight: 600, color: '#4B5878' }}>{u.time}</span>
                          </span>
                        ))}
                      </span>
                    </span>
                  </span>
                  <span style={{ position: 'absolute', top: '26px', right: phone ? '-6px' : '-30px', background: '#FFFFFF', borderRadius: '10px', boxShadow: '0 20px 44px rgba(0,0,0,0.35)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px', width: '150px' }}>
                    <span style={{ fontSize: '8.5px', fontWeight: 700, color: '#1B2333' }}>Productive vs Unproductive</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ flex: 'none', width: '56px', height: '56px', borderRadius: '50%', background: 'conic-gradient(#0D9488 0 72%,#CBD5E1 72% 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ width: '38px', height: '38px', borderRadius: '50%', background: '#FFFFFF', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1.2 }}>
                          <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '9px', color: '#1B2333' }}>72%</span>
                          <span style={{ fontSize: '5.5px', color: '#8A94A8' }}>Productive</span>
                        </span>
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '7px', fontWeight: 600, color: '#4B5878' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#0D9488' }} />Productive 72%</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#CBD5E1' }} />Unproductive 28%</span>
                      </span>
                    </span>
                  </span>
                  <span style={{ position: 'absolute', bottom: '-18px', left: '38px', background: '#FFFFFF', borderRadius: '10px', boxShadow: '0 20px 44px rgba(0,0,0,0.35)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '9px' }}>
                    <span style={{ flex: 'none', width: '24px', height: '24px', borderRadius: '7px', background: '#0D9488', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        <path d="m9 12 2 2 4-4" />
                      </svg>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                      <span style={{ fontSize: '9px', fontWeight: 700, color: '#1B2333' }}>Policy enforced</span>
                      <span style={{ fontSize: '8px', color: '#8A94A8' }}>USB device blocked</span>
                    </span>
                  </span>
                </span>
              </div>
              <div style={{ position: 'relative', flex: phone ? '0 0 auto' : tablet ? '1.15 1 0' : '1.2 1 400px', ...(phone ? { width: '100%', boxSizing: 'border-box' as const } : {}), minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '18px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '11.5px', fontWeight: 700, letterSpacing: '0.1em', color: '#5EEAD4', background: 'rgba(94,234,212,0.12)', border: '1px solid rgba(94,234,212,0.25)', padding: '7px 15px', borderRadius: '999px' }}>READY TO GET STARTED?</span>
                <h2 style={{ margin: 0, fontSize: 'clamp(28px,2.6vw,40px)', lineHeight: 1.2, letterSpacing: '-0.02em', fontWeight: 700, color: '#FFFFFF' }}>
                  Take control of your workforce.
                  <br />
                  Start your <span style={{ color: '#2DD4BF' }}>14-day free trial.</span>
                </h2>
                <div style={{ display: 'flex', gap: '26px', flexWrap: 'wrap', paddingTop: '4px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ flex: 'none', width: '40px', height: '40px', borderRadius: '50%', border: '1px solid rgba(94,234,212,0.3)', background: 'rgba(94,234,212,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5EEAD4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
                        <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
                      </svg>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: '#FFFFFF' }}>Quick setup</span>
                      <span style={{ fontSize: '11.5px', color: '#8FB8B2' }}>Get started in minutes</span>
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ flex: 'none', width: '40px', height: '40px', borderRadius: '50%', border: '1px solid rgba(94,234,212,0.3)', background: 'rgba(94,234,212,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5EEAD4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        <path d="m9 12 2 2 4-4" />
                      </svg>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: '#FFFFFF' }}>No credit card</span>
                      <span style={{ fontSize: '11.5px', color: '#8FB8B2' }}>required</span>
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ flex: 'none', width: '40px', height: '40px', borderRadius: '50%', border: '1px solid rgba(94,234,212,0.3)', background: 'rgba(94,234,212,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5EEAD4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <path d="M16 2v4M8 2v4M3 10h18" />
                      </svg>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: '#FFFFFF' }}>Full access</span>
                      <span style={{ fontSize: '11.5px', color: '#8FB8B2' }}>to all features</span>
                    </span>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', paddingTop: '6px' }}>
                  <HoverLink
                    to="/signup"
                    base={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: '#0D9488', color: '#FFFFFF', fontWeight: 700, fontSize: '15px', padding: '14px 28px', borderRadius: '12px', transition: 'all 0.25s ease' }}
                    hover={{ background: '#14B8A6', color: '#FFFFFF', transform: 'translateY(-2px)' }}
                  >
                    Start free trial <span style={{ fontWeight: 400 }}>→</span>
                  </HoverLink>
                  <HoverLink
                    to="/contact"
                    base={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'transparent', border: '1.5px solid rgba(255,255,255,0.3)', color: '#FFFFFF', fontWeight: 700, fontSize: '15px', padding: '14px 28px', borderRadius: '12px', transition: 'all 0.25s ease' }}
                    hover={{ border: '1.5px solid #5EEAD4', color: '#5EEAD4' }}
                  >
                    Book a demo
                  </HoverLink>
                </div>
                <span style={{ fontSize: '12.5px', color: '#8FB8B2' }}>Trusted by teams who value clarity, productivity and security.</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ---------- FOOTER ---------- */}
      </main>

      <footer style={{ background: '#05080D', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: phone ? '64px 20px 48px' : '64px 40px 48px', display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) repeat(4,minmax(0,1fr)) minmax(0,1.6fr)', gap: '38px', ...(phone ? { gridTemplateColumns: 'minmax(0,1fr)' } : tablet ? { gridTemplateColumns: '1fr 1fr' } : {}) }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <img src="/rudrans/rudrans-logo.webp" width="1221" height="1289" loading="lazy" decoding="async" alt="Rudrans logo" style={{ width: '44px', height: '44px', objectFit: 'contain' }} />
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
                <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', letterSpacing: '0.04em', color: '#FFFFFF' }}>RUDRANS</span>
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.3em', color: '#2DD4BF' }}>WORKFORCE MONITORING</span>
              </span>
            </span>
            <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.75, color: 'rgba(255,255,255,0.6)', maxWidth: '280px' }}>
              Rudrans helps modern organizations monitor, secure and optimize their digital workforce with complete visibility and control.
            </p>
            <span style={{ display: 'flex', gap: '12px' }}>
              <HoverA href="#" aria-label="LinkedIn" base={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }} hover={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V24h-4zM8.5 8h3.8v2.2h.1c.5-1 1.8-2.2 3.8-2.2 4 0 4.8 2.7 4.8 6.1V24h-4v-8.5c0-2-.04-4.7-2.9-4.7-2.9 0-3.3 2.2-3.3 4.5V24h-4z" /></svg>
              </HoverA>
              <HoverA href="#" aria-label="X" base={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }} hover={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.64 7.58H.46l8.6-9.83L0 1.15h7.59l5.24 6.93zm-1.29 19.5h2.04L6.49 3.24H4.3z" /></svg>
              </HoverA>
              <HoverA href="#" aria-label="YouTube" base={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }} hover={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4L15.8 12z" /></svg>
              </HoverA>
              <HoverA href="mailto:info@yugmasoft.com" aria-label="Email" base={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }} hover={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></svg>
              </HoverA>
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>PRODUCT</span>
            <FooterLink href="#top">Overview</FooterLink>
            <FooterLink href="#features">Features</FooterLink>
            <FooterLink href="#how">How It Works</FooterLink>
            <FooterLink href="#trends">Integrations</FooterLink>
            <FooterLink href="#pricing">Pricing</FooterLink>
            <FooterLink href="#">Roadmap</FooterLink>
            <FooterLink href="#">Changelog</FooterLink>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>SOLUTIONS</span>
            <FooterLink href="#features">Employee Monitoring</FooterLink>
            <FooterLink href="#features">Data Security</FooterLink>
            <FooterLink href="#trends">Productivity Analytics</FooterLink>
            <FooterLink href="#">Insider Threat Prevention</FooterLink>
            <FooterLink href="#">Compliance Management</FooterLink>
            <FooterLink href="#">Remote Work</FooterLink>
            <FooterLink href="#">For IT Teams</FooterLink>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>RESOURCES</span>
            <FooterLink href="#">Blog</FooterLink>
            <FooterLink href="#">Case Studies</FooterLink>
            <FooterLink href="#">Ebooks &amp; Guides</FooterLink>
            <FooterLink href="#">Webinars</FooterLink>
            <HoverLink to="/contact" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Help Center</HoverLink>
            <HoverLink to="/docs/integrations" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>API Documentation</HoverLink>
            <FooterLink href="#">Release Notes</FooterLink>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>COMPANY</span>
            <HoverLink to="/about" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>About Us</HoverLink>
            <FooterLink href="#">Careers</FooterLink>
            <HoverA href="https://srvora.com" target="_blank" rel="noopener" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Partners</HoverA>
            <FooterLink href="#">Newsroom</FooterLink>
            <FooterLink href="#">Trust Center</FooterLink>
            <HoverLink to="/contact" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Contact Us</HoverLink>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: '34px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF' }}>STAY UPDATED</span>
            <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.7, color: 'rgba(255,255,255,0.6)' }}>Subscribe to our newsletter for product updates, insights and best practices.</p>
            <span style={{ display: 'flex', alignItems: 'stretch', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', overflow: 'hidden' }}>
              <input type="email" placeholder="Enter your email" style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', padding: '15px 16px', fontSize: '13.5px', color: '#FFFFFF', fontFamily: "'IBM Plex Sans',sans-serif" }} />
              <HoverButton aria-label="Subscribe to newsletter" base={{ flex: 'none', width: '52px', border: 'none', cursor: 'pointer', background: '#0D9488', color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.25s ease' }} hover={{ background: '#14B8A6' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </HoverButton>
            </span>
            <span style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', fontSize: '12.5px', lineHeight: 1.55, color: 'rgba(255,255,255,0.55)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2DD4BF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: '2px' }}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              We respect your privacy. Unsubscribe anytime.
            </span>
          </div>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ maxWidth: '1400px', margin: '0 auto', padding: phone ? '22px 20px' : '22px 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '20px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.55)' }}>
              © 2026 Rudrans · A{' '}
              <HoverA href="https://www.yugmasoft.com" target="_blank" rel="noopener" base={{ color: 'rgba(255,255,255,0.75)', fontWeight: 600 }} hover={{ color: '#FFFFFF' }}>Yugma Soft</HoverA> product. All rights reserved.
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 0, fontSize: '13px', flexWrap: 'wrap' }}>
              <HoverLink to="/legal/privacy" base={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }} hover={{ color: '#FFFFFF' }}>Privacy Policy</HoverLink>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
              <HoverLink to="/legal/terms" base={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }} hover={{ color: '#FFFFFF' }}>Terms of Service</HoverLink>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
              <HoverA href="#" base={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }} hover={{ color: '#FFFFFF' }}>Data Processing Addendum</HoverA>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', color: 'rgba(255,255,255,0.8)' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M2 12h20M12 3a15.3 15.3 0 0 1 0 18 15.3 15.3 0 0 1 0-18z" /></svg>
              English{' '}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
