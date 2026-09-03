import '@/styles/rudrans-site.css';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useSitePlans, type SitePlan } from '@/lib/useSitePlans';
import SiteHeader from '../SiteHeader';
import { useSeo } from '@/lib/seo';

function useMax(px: number) {
  const [m, setM] = useState(() => window.matchMedia(`(max-width:${px}px)`).matches);
  useEffect(() => { const mq = window.matchMedia(`(max-width:${px}px)`); const on = () => setM(mq.matches); on(); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, [px]);
  return m;
}

const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  if (Number.isNaN(n)) return `rgba(13,148,136,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function PlanIcon({ icon, color }: { icon: SitePlan['icon']; color: string }) {
  const common = {
    width: 27, height: 27, viewBox: '0 0 24 24', fill: 'none', stroke: color,
    strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  if (icon === 'chart') return <svg {...common}><rect x="2" y="3" width="20" height="16" rx="2"></rect><path d="m7 14 3-3 2.5 2.5L17 9"></path><path d="M14 9h3v3"></path></svg>;
  if (icon === 'building') return <svg {...common}><rect x="4" y="2" width="16" height="20" rx="2"></rect><path d="M9 6h1M14 6h1M9 10h1M14 10h1M9 14h1M14 14h1M9 22v-4h6v4"></path></svg>;
  return <svg {...common}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path></svg>;
}

function Feature({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
      <span style={{ flex: 'none', width: '20px', height: '20px', borderRadius: '50%', border: `1.6px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
      </span>
      <span style={{ fontSize: '14.5px', color: 'var(--ink2)' }}>{children}</span>
    </span>
  );
}

const faqs: { icon: React.ReactNode; q: string; a: string }[] = [
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"></path><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"></path><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"></path></svg>
    ),
    q: 'Can I upgrade or downgrade my plan anytime?',
    a: 'Yes, you can upgrade or downgrade your plan at any time. Your billing will be adjusted accordingly, so you only pay for what you use.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4M8 2v4M3 10h18"></path></svg>
    ),
    q: 'Is there a free trial available?',
    a: 'Yes — every plan starts with a 7-day free trial with full access to all features. No credit card required to get started.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><path d="M2 10h20"></path></svg>
    ),
    q: 'What payment methods do you accept?',
    a: 'We accept all major credit and debit cards, UPI and net banking. For Enterprise plans we also support invoicing and bank transfers.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
    ),
    q: 'Is my data secure with Rudrans?',
    a: 'Absolutely. All data is encrypted in transit and at rest, access is role-based, and you control data retention. Your monitoring data is never shared with third parties.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5zM21 11h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-5z"></path><path d="M3 11a9 9 0 0 1 18 0"></path></svg>
    ),
    q: 'Do you offer discounts for yearly billing?',
    a: 'Yes — yearly billing saves you 20% compared to monthly billing. For larger teams, talk to our sales team about volume discounts.',
  },
];

export default function Pricing() {
  useSeo('pricing');
  const [yearly, setYearly] = useState(false);
  const [faq, setFaq] = useState(0);
  const tablet = useMax(900);
  const phone = useMax(600);

  // Cards are configured from the super-admin portal (/admin/plans →
  // "Website pricing cards") — public.site_plans, anon-readable.
  const plans = useSitePlans();

  const toggleBase: React.CSSProperties = {
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: 700,
    fontSize: '14.5px',
    padding: '10px 22px',
    borderRadius: '999px',
    display: 'inline-flex',
    alignItems: 'center',
    transition: 'all 0.2s ease',
  };
  const activeToggle: React.CSSProperties = { background: 'var(--blue)', color: '#FFFFFF', boxShadow: '0 6px 16px rgba(13,148,136,0.3)' };
  const inactiveToggle: React.CSSProperties = { background: 'transparent', color: 'var(--ink2)' };
  const mStyle: React.CSSProperties = { ...toggleBase, ...(yearly ? inactiveToggle : activeToggle) };
  const yStyle: React.CSSProperties = { ...toggleBase, ...(yearly ? activeToggle : inactiveToggle) };

  const toggleFaq = (i: number) => setFaq(faq === i ? -1 : i);

  return (
    <div className="rd-site">
      <SiteHeader active="pricing" />

      <main style={{ display: 'contents' }}>

      <section id="top" style={{ position: 'relative', overflow: 'hidden', background: 'linear-gradient(180deg,var(--bg2),var(--bg))' }}>
        <div style={{ position: 'relative', maxWidth: '1400px', margin: '0 auto', padding: '56px 40px 48px', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,0.85fr)', gap: 0, alignItems: 'center', ...(tablet ? { gridTemplateColumns: 'minmax(0,1fr)', gap: '36px' } : {}), ...(phone ? { padding: '56px 20px 48px' } : {}) }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '22px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, letterSpacing: '0.16em', color: 'var(--blue)', background: 'var(--blue-soft)', padding: '8px 16px', borderRadius: '999px' }}><span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--green)', animation: 'rd-pulse 2s ease-in-out infinite' }}></span>PRICING</span>
            <h1 style={{ margin: 0, fontSize: 'clamp(34px,3.9vw,58px)', lineHeight: 1.13, letterSpacing: '-0.03em', fontWeight: 700 }}>Simple pricing.<br /><span style={{ background: 'linear-gradient(90deg,#0D9488,#2DD4BF)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Serious visibility.</span></h1>
            <p style={{ margin: 0, fontSize: '17.5px', lineHeight: 1.7, color: 'var(--ink2)', maxWidth: '460px', textWrap: 'pretty' } as React.CSSProperties}>Choose the plan that fits today. Scale seamlessly as you grow.</p>
            <span style={{ display: 'flex', alignItems: 'center', gap: '22px', flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '14.5px', fontWeight: 600, color: 'var(--ink2)' }}><span style={{ width: '22px', height: '22px', borderRadius: '50%', background: '#0D9488', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></span>7-day free trial</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '14.5px', fontWeight: 600, color: 'var(--ink2)' }}><span style={{ width: '22px', height: '22px', borderRadius: '50%', background: '#0D9488', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></span>No credit card required</span>
            </span>
            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '4px' }}>
              <a href="#plans" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'var(--blue)', color: '#FFFFFF', fontWeight: 700, fontSize: '15.5px', padding: '15px 28px', borderRadius: '12px', transition: 'all 0.25s ease' }}>View plans <span style={{ fontWeight: 400 }}>→</span></a>
              <a href="#compare" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'var(--card)', border: '1.5px solid var(--line2)', color: 'var(--ink)', fontWeight: 700, fontSize: '15.5px', padding: '15px 28px', borderRadius: '12px', transition: 'all 0.25s ease' }}>Compare plans</a>
            </div>
          </div>
          <div style={{ position: 'relative', minWidth: 0, display: 'flex', justifyContent: tablet ? 'center' : 'flex-start' }}>
            <img src="/rudrans/pricing-hero.webp" width="954" height="986" fetchPriority="high" decoding="async" alt="Three rising 3D steps labeled Start, Grow and Scale with a rocket launching along an upward arc and a handwritten note reading: a plan for every stage of your journey" style={{ display: 'block', width: 'auto', maxWidth: '100%', maxHeight: tablet ? '420px' : '520px', height: 'auto' }} />
          </div>
        </div>
      </section>

      <section id="plans" style={{ background: 'var(--bg2)', borderTop: '1px solid var(--line)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '84px 40px 72px', display: 'flex', flexDirection: 'column', alignItems: 'center', ...(phone ? { padding: '84px 20px 72px' } : {}) }}>
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}><span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.2em', color: 'var(--blue)' }}>PRICING</span><span style={{ width: '34px', height: '2.5px', borderRadius: '2px', background: 'var(--blue)' }}></span></span>
          <h2 style={{ margin: '18px 0 0', fontSize: 'clamp(30px,3.4vw,50px)', lineHeight: 1.14, letterSpacing: '-0.025em', fontWeight: 700, textAlign: 'center', textWrap: 'balance' } as React.CSSProperties}>Choose the plan that<br /><span style={{ background: 'linear-gradient(90deg,#0D9488,#2DD4BF)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>fits your team.</span></h2>
          <p style={{ margin: '14px 0 0', fontSize: '16.5px', lineHeight: 1.65, color: 'var(--ink2)', textAlign: 'center', maxWidth: '560px' }}>Start simple. Upgrade when you need more visibility and control.</p>
          <div style={{ display: 'flex', alignItems: 'center', background: 'var(--card)', border: '1px solid var(--line2)', borderRadius: '999px', padding: '5px', marginTop: '28px', gap: '4px' }}>
            <button onClick={() => setYearly(false)} style={mStyle}>Monthly</button>
            <button onClick={() => setYearly(true)} style={yStyle}>Yearly <span style={{ background: 'rgba(13,148,136,0.12)', color: '#0D9488', fontSize: '12px', fontWeight: 700, padding: '4px 10px', borderRadius: '999px', marginLeft: '6px' }}>Save 20%</span></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', gap: '24px', width: '100%', maxWidth: '1180px', marginTop: '44px', alignItems: 'stretch' }}>
            {plans.map((p) => {
              const badge = p.badge?.trim() || null;
              const price = yearly ? p.price_yearly : p.price_monthly;
              const iconBubble = (
                <span style={{ width: '64px', height: '64px', borderRadius: '18px', background: rgba(p.accent, 0.1), display: 'flex', alignItems: 'center', justifyContent: 'center' }}><PlanIcon icon={p.icon} color={p.accent} /></span>
              );
              const nameEl = <span style={{ marginTop: '18px', fontSize: '15px', fontWeight: 700, letterSpacing: '0.14em', color: p.accent }}>{p.name.toUpperCase()}</span>;
              const taglineEl = p.tagline && <span style={{ marginTop: '10px', fontSize: '14.5px', lineHeight: 1.6, color: 'var(--ink2)', textAlign: 'center' }}>{p.tagline}</span>;
              const priceEl = p.custom_price_label ? (
                <span style={{ marginTop: '20px', fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '34px', letterSpacing: '-0.02em' }}>{p.custom_price_label}</span>
              ) : (
                <>
                  <span style={{ marginTop: '18px', display: 'flex', alignItems: 'baseline', gap: '2px' }}><span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '44px', letterSpacing: '-0.02em' }}>{p.currency_symbol}{Number(price ?? 0)}</span></span>
                  <span style={{ fontSize: '13.5px', color: 'var(--ink3)', marginTop: '2px' }}>{p.price_note}</span>
                </>
              );
              const featuresEl = (
                <span style={{ display: 'flex', flexDirection: 'column', gap: '13px', width: '100%', alignItems: 'flex-start' }}>
                  {p.features.map((f, i) => <Feature key={i} color={p.accent}>{f}</Feature>)}
                </span>
              );
              const ctaStyle: React.CSSProperties = {
                marginTop: '28px', width: '100%', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                fontWeight: 700, fontSize: '15px', borderRadius: '12px', transition: 'all 0.25s ease',
                ...(badge
                  ? { background: p.accent, color: '#FFFFFF', padding: '15px 20px' }
                  : { background: 'var(--card)', border: `1.5px solid ${p.accent}`, color: p.accent, padding: '14px 20px' }),
              };
              const ctaInner = <>{p.cta_label} <span style={{ fontWeight: 400 }}>→</span></>;
              const ctaEl = p.cta_href.startsWith('/')
                ? <Link to={p.cta_href} style={ctaStyle}>{ctaInner}</Link>
                : <a href={p.cta_href} style={ctaStyle}>{ctaInner}</a>;
              const body = <>{iconBubble}{nameEl}{taglineEl}{priceEl}<span style={{ width: '100%', borderTop: '1px solid var(--line)', margin: '22px 0' }}></span>{featuresEl}{ctaEl}</>;

              if (badge) {
                return (
                  <div key={p.id} style={{ position: 'relative', background: 'var(--card)', border: `2px solid ${p.accent}`, borderRadius: '20px', padding: '0 0 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', boxShadow: `0 24px 54px ${rgba(p.accent, 0.16)}`, overflow: 'hidden' }}>
                    <span style={{ width: '100%', background: `linear-gradient(90deg,${p.accent},${rgba(p.accent, 0.8)})`, color: '#FFFFFF', fontSize: '13px', fontWeight: 700, letterSpacing: '0.12em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '11px 0' }}><svg width="13" height="13" viewBox="0 0 24 24" fill="#FFFFFF"><path d="M12 2l2.9 6.26L21.5 9.27l-4.75 4.28L18.18 21 12 17.27 5.82 21l1.43-7.45L2.5 9.27l6.6-1.01z"></path></svg>{badge}</span>
                    <div style={{ padding: '30px 34px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', boxSizing: 'border-box', flex: 1 }}>
                      {body}
                    </div>
                  </div>
                );
              }
              return (
                <div key={p.id} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '20px', padding: '38px 34px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, boxShadow: '0 12px 30px rgba(13,38,84,0.05)' }}>
                  {body}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, flexWrap: 'wrap', marginTop: '52px', width: '100%', ...(tablet && !phone ? { gap: '28px' } : {}), ...(phone ? { flexDirection: 'column' as const, alignItems: 'flex-start', gap: '18px' } : {}) }}>
            <span style={{ padding: tablet ? '0' : '0 34px' }}><span style={{ display: 'flex', alignItems: 'center', gap: '13px' }}><span style={{ width: '42px', height: '42px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="m9 12 2 2 4-4"></path></svg></span><span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}><span style={{ fontWeight: 700, fontSize: '14.5px' }}>7-day free trial</span><span style={{ fontSize: '13px', color: 'var(--ink2)' }}>No credit card required</span></span></span></span>
            <span style={{ width: '1px', alignSelf: 'stretch', background: 'var(--line2)', display: tablet ? 'none' : undefined }}></span>
            <span style={{ padding: tablet ? '0' : '0 34px' }}><span style={{ display: 'flex', alignItems: 'center', gap: '13px' }}><span style={{ width: '42px', height: '42px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></span><span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}><span style={{ fontWeight: 700, fontSize: '14.5px' }}>Secure & compliant</span><span style={{ fontSize: '13px', color: 'var(--ink2)' }}>Enterprise-grade security</span></span></span></span>
            <span style={{ width: '1px', alignSelf: 'stretch', background: 'var(--line2)', display: tablet ? 'none' : undefined }}></span>
            <span style={{ padding: tablet ? '0' : '0 34px' }}><span style={{ display: 'flex', alignItems: 'center', gap: '13px' }}><span style={{ width: '42px', height: '42px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5zM21 11h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-5z"></path><path d="M3 11a9 9 0 0 1 18 0"></path></svg></span><span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}><span style={{ fontWeight: 700, fontSize: '14.5px' }}>Expert support</span><span style={{ fontSize: '13px', color: 'var(--ink2)' }}>We’re here to help</span></span></span></span>
          </div>
        </div>
      </section>

      <section id="faq" style={{ background: 'var(--bg)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '84px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', ...(phone ? { padding: '84px 20px' } : {}) }}>
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}><span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.2em', color: 'var(--blue)' }}>FAQ</span><span style={{ width: '34px', height: '2.5px', borderRadius: '2px', background: 'var(--blue)' }}></span></span>
          <h2 style={{ margin: '18px 0 0', fontSize: 'clamp(30px,3.4vw,50px)', lineHeight: 1.14, letterSpacing: '-0.025em', fontWeight: 700, textAlign: 'center', textWrap: 'balance' } as React.CSSProperties}>Frequently asked <span style={{ background: 'linear-gradient(90deg,#0D9488,#2DD4BF)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>questions</span></h2>
          <p style={{ margin: '14px 0 0', fontSize: '16.5px', lineHeight: 1.65, color: 'var(--ink2)', textAlign: 'center', maxWidth: '560px' }}>Everything you need to know about our pricing and plans.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%', maxWidth: '1000px', marginTop: '44px' }}>
            {faqs.map((item, i) => {
              const open = faq === i;
              const cardStyle: React.CSSProperties = {
                background: 'var(--card)',
                borderRadius: '16px',
                overflow: 'hidden',
                transition: 'all 0.25s ease',
                ...(open
                  ? { border: '1px solid rgba(13,148,136,0.4)', boxShadow: '0 14px 34px rgba(13,148,136,0.1),inset 3px 0 0 #0D9488' }
                  : { border: '1px solid var(--line)', boxShadow: '0 6px 18px rgba(13,38,84,0.04)' }),
              };
              const chevStyle: React.CSSProperties = {
                flex: 'none',
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.25s ease',
                ...(open
                  ? { background: 'var(--blue-soft)', color: '#0D9488', border: '1.5px solid rgba(13,148,136,0.4)', transform: 'rotate(180deg)' }
                  : { background: 'transparent', color: 'var(--ink2)', border: '1.5px solid transparent' }),
              };
              return (
                <div key={i} style={cardStyle}>
                  <button onClick={() => toggleFaq(i)} style={{ display: 'flex', alignItems: 'center', gap: '18px', width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '22px 26px', textAlign: 'left', fontFamily: "'IBM Plex Sans',sans-serif" }}>
                    <span style={{ flex: 'none', width: '48px', height: '48px', borderRadius: '50%', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{item.icon}</span>
                    <span style={{ flex: 1, fontWeight: 700, fontSize: '17px', color: 'var(--ink)' }}>{item.q}</span>
                    <span style={chevStyle}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"></path></svg></span>
                  </button>
                  {open && (
                    <span style={{ display: 'block', padding: '0 26px 24px 92px', fontSize: '15px', lineHeight: 1.7, color: 'var(--ink2)', textWrap: 'pretty' } as React.CSSProperties}>{item.a}</span>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ width: '100%', maxWidth: '1180px', marginTop: '56px', background: 'linear-gradient(120deg,#E9F4F1,#F0F6F8)', border: '1px solid var(--line)', borderRadius: '22px', padding: '36px 44px', display: 'flex', alignItems: 'center', gap: '36px', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ width: '52px', height: '52px', borderRadius: '50%', background: 'linear-gradient(135deg,#0D9488,#2DD4BF)', border: '3px solid #FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFFFFF', fontWeight: 700, fontSize: '16px' }}>A</span>
              <span style={{ width: '52px', height: '52px', borderRadius: '50%', background: 'linear-gradient(135deg,#14B8A6,#0D9488)', border: '3px solid #FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFFFFF', fontWeight: 700, fontSize: '16px', marginLeft: '-14px' }}>R</span>
              <span style={{ width: '52px', height: '52px', borderRadius: '50%', background: 'linear-gradient(135deg,#2DD4BF,#14B8A6)', border: '3px solid #FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FFFFFF', fontWeight: 700, fontSize: '16px', marginLeft: '-14px' }}>S</span>
              <span style={{ width: '52px', height: '52px', borderRadius: '50%', background: '#EDE9FE', border: '3px solid #FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7C3AED', fontWeight: 700, fontSize: '14px', marginLeft: '-14px' }}>+250</span>
            </span>
            <span style={{ flex: 1, minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontWeight: 700, fontSize: '21px' }}>Still have questions?</span>
              <span style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--ink2)' }}>Our team is here to help you find the right plan for your team.</span>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
              <Link to="/contact" style={{ display: 'inline-flex', alignItems: 'center', gap: '9px', background: 'var(--blue)', color: '#FFFFFF', fontWeight: 700, fontSize: '15px', padding: '14px 26px', borderRadius: '12px', transition: 'all 0.25s ease' }}>Talk to our team <span style={{ fontWeight: 400 }}>→</span></Link>
              <Link to="/contact" style={{ fontSize: '14px', fontWeight: 600, color: '#0D9488', textDecoration: 'underline', textUnderlineOffset: '3px' }}>Contact support</Link>
            </span>
          </div>
        </div>
      </section>

      </main>


      <footer style={{ background: '#05080D', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '64px 40px 48px', display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) repeat(4,minmax(0,1fr)) minmax(0,1.6fr)', gap: '38px', ...(tablet ? { gridTemplateColumns: '1fr 1fr' } : {}), ...(phone ? { gridTemplateColumns: 'minmax(0,1fr)', padding: '64px 20px 48px' } : {}) }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <img src="/rudrans/rudrans-logo.webp" width="1221" height="1289" loading="lazy" decoding="async" alt="Rudrans logo" style={{ width: '44px', height: '44px', objectFit: 'contain' }} />
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}><span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', letterSpacing: '0.04em', color: '#FFFFFF' }}>RUDRANS</span><span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.3em', color: '#2DD4BF' }}>WORKFORCE MONITORING</span></span>
            </span>
            <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.75, color: 'rgba(255,255,255,0.6)', maxWidth: '280px' }}>Rudrans helps modern organizations monitor, secure and optimize their digital workforce with complete visibility and control.</p>
            <span style={{ display: 'flex', gap: '12px' }}>
              <a href="#" aria-label="LinkedIn" style={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V24h-4zM8.5 8h3.8v2.2h.1c.5-1 1.8-2.2 3.8-2.2 4 0 4.8 2.7 4.8 6.1V24h-4v-8.5c0-2-.04-4.7-2.9-4.7-2.9 0-3.3 2.2-3.3 4.5V24h-4z"></path></svg></a>
              <a href="#" aria-label="X" style={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.64 7.58H.46l8.6-9.83L0 1.15h7.59l5.24 6.93zm-1.29 19.5h2.04L6.49 3.24H4.3z"></path></svg></a>
              <a href="#" aria-label="YouTube" style={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }}><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4L15.8 12z"></path></svg></a>
              <a href="mailto:info@yugmasoft.com" aria-label="Email" style={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="m22 7-10 6L2 7"></path></svg></a>
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>PRODUCT</span>
            <Link to="/" style={{ color: 'rgba(255,255,255,0.68)' }}>Overview</Link>
            <Link to="/" style={{ color: 'rgba(255,255,255,0.68)' }}>Features</Link>
            <Link to="/how-it-works" style={{ color: 'rgba(255,255,255,0.68)' }}>How It Works</Link>
            <Link to="/" style={{ color: 'rgba(255,255,255,0.68)' }}>Integrations</Link>
            <Link to="/pricing" style={{ color: 'rgba(255,255,255,0.68)' }}>Pricing</Link>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Roadmap</a>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Changelog</a>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>SOLUTIONS</span>
            <Link to="/" style={{ color: 'rgba(255,255,255,0.68)' }}>Employee Monitoring</Link>
            <Link to="/" style={{ color: 'rgba(255,255,255,0.68)' }}>Data Security</Link>
            <Link to="/" style={{ color: 'rgba(255,255,255,0.68)' }}>Productivity Analytics</Link>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Insider Threat Prevention</a>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Compliance Management</a>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Remote Work</a>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>For IT Teams</a>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>RESOURCES</span>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Blog</a>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Case Studies</a>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Ebooks & Guides</a>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Webinars</a>
            <Link to="/contact" style={{ color: 'rgba(255,255,255,0.68)' }}>Help Center</Link>
            <Link to="/docs/integrations" style={{ color: 'rgba(255,255,255,0.68)' }}>API Documentation</Link>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Release Notes</a>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>COMPANY</span>
            <Link to="/about" style={{ color: 'rgba(255,255,255,0.68)' }}>About Us</Link>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Careers</a>
            <a href="https://srvora.com" target="_blank" rel="noopener" style={{ color: 'rgba(255,255,255,0.68)' }}>Partners</a>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Newsroom</a>
            <a href="#" style={{ color: 'rgba(255,255,255,0.68)' }}>Trust Center</a>
            <Link to="/contact" style={{ color: 'rgba(255,255,255,0.68)' }}>Contact Us</Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: '34px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF' }}>STAY UPDATED</span>
            <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.7, color: 'rgba(255,255,255,0.6)' }}>Subscribe to our newsletter for product updates, insights and best practices.</p>
            <span style={{ display: 'flex', alignItems: 'stretch', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', overflow: 'hidden' }}>
              <input type="email" placeholder="Enter your email" style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', padding: '15px 16px', fontSize: '13.5px', color: '#FFFFFF', fontFamily: "'IBM Plex Sans',sans-serif" }} />
              <button aria-label="Subscribe to newsletter" style={{ flex: 'none', width: '52px', border: 'none', cursor: 'pointer', background: '#0D9488', color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.25s ease' }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></button>
            </span>
            <span style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', fontSize: '12.5px', lineHeight: 1.55, color: 'rgba(255,255,255,0.55)' }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2DD4BF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: '2px' }}><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>We respect your privacy. Unsubscribe anytime.</span>
          </div>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '22px 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '20px', flexWrap: 'wrap', ...(phone ? { padding: '22px 20px' } : {}) }}>
            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.55)' }}>© 2026 Rudrans · A <a href="https://www.yugmasoft.com" target="_blank" rel="noopener" style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 600 }}>Yugma Soft</a> product. All rights reserved.</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 0, fontSize: '13px', flexWrap: 'wrap' }}>
              <Link to="/legal/privacy" style={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }}>Privacy Policy</Link>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
              <Link to="/legal/terms" style={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }}>Terms of Service</Link>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
              <a href="#" style={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }}>Data Processing Addendum</a>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', color: 'rgba(255,255,255,0.8)' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M2 12h20M12 3a15.3 15.3 0 0 1 0 18 15.3 15.3 0 0 1 0-18z"></path></svg>English <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"></path></svg></span>
          </div>
        </div>
      </footer>
    </div>
  );
}
