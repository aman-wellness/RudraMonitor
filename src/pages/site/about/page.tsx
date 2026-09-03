import '@/styles/rudrans-site.css';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import SiteHeader from '../SiteHeader';
import { useSeo } from '@/lib/seo';

/* ---- hover helpers (base look is pixel-perfect; hover mirrors source style-hover) ---- */
type HoverLinkProps = {
  to?: string;
  href?: string;
  base: React.CSSProperties;
  hover: React.CSSProperties;
  children: React.ReactNode;
  target?: string;
  rel?: string;
  'aria-label'?: string;
};
function HoverLink({ to, href, base, hover, children, ...rest }: HoverLinkProps) {
  const [h, setH] = useState(false);
  const style = { ...base, ...(h ? hover : {}) } as React.CSSProperties;
  const shared = { style, onMouseEnter: () => setH(true), onMouseLeave: () => setH(false), ...rest };
  return to != null ? (
    <Link to={to} {...shared}>{children}</Link>
  ) : (
    <a href={href} {...shared}>{children}</a>
  );
}
function HoverDiv({ base, hover, children }: { base: React.CSSProperties; hover: React.CSSProperties; children: React.ReactNode }) {
  const [h, setH] = useState(false);
  return (
    <div
      style={{ ...base, ...(h ? hover : {}) } as React.CSSProperties}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
    >
      {children}
    </div>
  );
}
function HoverButton({ base, hover, children, ...rest }: { base: React.CSSProperties; hover: React.CSSProperties; children: React.ReactNode; 'aria-label'?: string }) {
  const [h, setH] = useState(false);
  return (
    <button
      type="button"
      {...rest}
      style={{ ...base, ...(h ? hover : {}) } as React.CSSProperties}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
    >
      {children}
    </button>
  );
}

function useMax(px: number) {
  const [m, setM] = useState(() => window.matchMedia(`(max-width:${px}px)`).matches);
  useEffect(() => { const mq = window.matchMedia(`(max-width:${px}px)`); const on = () => setM(mq.matches); on(); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, [px]);
  return m;
}

export default function About() {
  useSeo('about');
  // From <script data-dc-script> componentDidMount(): force light rendering for this page.
  useEffect(() => {
    delete document.body.dataset.theme;
  }, []);
  const tablet = useMax(900);
  const phone = useMax(600);

  return (
    <div className="rd-site">
      {/* helmet @keyframes not already in rudrans-site.css */}
      <style>{`@keyframes rd-ring{0%{transform:translate(-50%,-50%) scale(1);opacity:0.8}100%{transform:translate(-50%,-50%) scale(1.75);opacity:0}}`}</style>

      <SiteHeader active="about" />


      <main style={{ display: 'contents' }}>

      <section id="top" style={{ position: 'relative', overflow: 'hidden', background: 'var(--bg2)' }}>
        <div style={{ position: 'relative', maxWidth: '1400px', margin: '0 auto', padding: '70px 40px 60px', display: 'grid', gridTemplateColumns: 'minmax(0,1.02fr) minmax(0,0.98fr)', gap: '32px', alignItems: 'center', ...(tablet ? { gridTemplateColumns: 'minmax(0,1fr)' } : {}), ...(phone ? { padding: '70px 20px 60px' } : {}) }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '22px' }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.18em', color: 'var(--blue)' }}>ABOUT RUDRANS</span>
              <span style={{ width: '34px', height: '2.5px', borderRadius: '2px', background: 'var(--blue)' }}></span>
            </span>
            <h1 style={{ margin: 0, fontSize: 'clamp(34px,3.8vw,56px)', lineHeight: 1.12, letterSpacing: '-0.03em', fontWeight: 700, textWrap: 'balance' } as React.CSSProperties}>Work is changing.<br /><span style={{ color: 'var(--blue)' }}>Visibility shouldn't disappear with it.</span></h1>
            <p style={{ margin: 0, fontSize: '17.5px', lineHeight: 1.75, color: 'var(--ink2)', maxWidth: '560px', textWrap: 'pretty' } as React.CSSProperties}>Rudrans was built for organizations that need a clearer understanding of how work happens — without relying on assumptions, spreadsheets, or constant check-ins.</p>
            <span style={{ width: '100%', maxWidth: '520px', borderTop: '1px solid var(--line)' }}></span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '15px', flexWrap: 'wrap' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"></path><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path></svg>
              <span style={{ fontWeight: 700 }}>Built by <a href="https://www.yugmasoft.com" target="_blank" rel="noopener" style={{ fontWeight: 700 }}>Yugma Soft Pvt. Ltd.</a></span>
              <span style={{ color: 'var(--ink3)' }}>·</span>
              <span style={{ fontWeight: 600, color: 'var(--blue)' }}>Made in India</span>
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', minWidth: 0 }}>
            <img src="/rudrans/about-hero-mascot2.webp" width="1502" height="1047" fetchPriority="high" decoding="async" alt="Rudrans mascot examining live activity cards with a magnifying glass" style={{ width: '100%', height: 'auto' }} />
          </div>
        </div>
      </section>

      <section id="problem" style={{ background: 'var(--bg)', overflow: 'hidden', borderTop: '1px solid var(--line)' }}>
        <div style={{ maxWidth: '1480px', margin: '0 auto', padding: '84px 40px 0', ...(phone ? { padding: '84px 20px 0' } : {}) }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', textAlign: 'center', marginBottom: '60px' }}>
            <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.2em', color: '#2DD4BF' }}>THE PROBLEM</span>
            <h2 style={{ margin: 0, fontSize: 'clamp(34px,3.8vw,58px)', lineHeight: 1.12, letterSpacing: '-0.02em', fontWeight: 700 }}>Work is happening.<br /><span style={{ color: '#2DD4BF' }}>Seeing it clearly is harder.</span></h2>
            <span style={{ width: '64px', height: '3px', borderRadius: '2px', background: '#2DD4BF', marginTop: '6px' }}></span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', gap: 0 }}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '11px', padding: '0 36px', borderRight: '1px solid var(--line)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '12px', fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '18px', color: '#0D9488' }}>01 <span style={{ width: '26px', height: '2.5px', background: '#0D9488', opacity: 0.6 }}></span></span>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '21px', letterSpacing: '-0.01em' }}>When everything looks fine</span>
              <p style={{ margin: 0, fontSize: '15.5px', lineHeight: 1.6, color: 'var(--ink2)', textWrap: 'pretty' } as React.CSSProperties}>Everyone is online.<br />But who's actually getting work done?</p>
              <div style={{ position: 'relative', height: '230px' }}><img src="/rudrans/about-card1.webp" width="1536" height="1024" loading="lazy" decoding="async" alt="Employees showing online across devices" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%) scale(1.15)', width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '11px', padding: '0 36px', borderRight: '1px solid var(--line)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '12px', fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '18px', color: '#0D9488' }}>02 <span style={{ width: '26px', height: '2.5px', background: '#0D9488', opacity: 0.6 }}></span></span>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '21px', letterSpacing: '-0.01em' }}>When something goes wrong</span>
              <p style={{ margin: 0, fontSize: '15.5px', lineHeight: 1.6, color: 'var(--ink2)', textWrap: 'pretty' } as React.CSSProperties}>A missed deadline, unusual activity, or productivity drop often gets noticed after the fact.</p>
              <div style={{ position: 'relative', height: '230px' }}><img src="/rudrans/about-card2.webp" width="1536" height="1024" loading="lazy" decoding="async" alt="Declining chart with missed deadline and unusual activity alerts" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '11px', padding: '0 36px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '12px', fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '18px', color: '#0D9488' }}>03 <span style={{ width: '26px', height: '2.5px', background: '#0D9488', opacity: 0.6 }}></span></span>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '21px', letterSpacing: '-0.01em' }}>When you need context</span>
              <p style={{ margin: 0, fontSize: '15.5px', lineHeight: 1.6, color: 'var(--ink2)', textWrap: 'pretty' } as React.CSSProperties}>Screenshots, spreadsheets and status updates only show fragments of the picture.</p>
              <div style={{ position: 'relative', height: '230px' }}><img src="/rudrans/about-card3-clean.webp" width="1536" height="1024" loading="lazy" decoding="async" alt="Scattered screenshots, spreadsheets, status updates and notes" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} /></div>
            </div>
          </div>
          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '0 0 40px' }}>
            <svg viewBox="0 0 1200 96" preserveAspectRatio="none" style={{ width: '100%', height: '96px', display: 'block', ...(tablet ? { display: 'none' } : {}) }}>
              <path d="M200,0 C200,46 212,54 262,54 L520,54 C558,54 568,62 568,90" fill="none" stroke="#2DD4BF" strokeWidth="1.6" strokeDasharray="5 6" opacity="0.7" vectorEffect="non-scaling-stroke"></path>
              <path d="M1000,0 C1000,46 988,54 938,54 L680,54 C642,54 632,62 632,90" fill="none" stroke="#2DD4BF" strokeWidth="1.6" strokeDasharray="5 6" opacity="0.7" vectorEffect="non-scaling-stroke"></path>
              <path d="M600,0 L600,56" fill="none" stroke="#2DD4BF" strokeWidth="1.6" strokeDasharray="5 6" opacity="0.7" vectorEffect="non-scaling-stroke"></path>
              <circle cx="600" cy="70" r="6" fill="#2DD4BF"></circle>
              <circle cx="600" cy="70" r="12" fill="#2DD4BF" opacity="0.2"><animate attributeName="r" values="8;15;8" dur="2.2s" repeatCount="indefinite"></animate><animate attributeName="opacity" values="0.3;0.08;0.3" dur="2.2s" repeatCount="indefinite"></animate></circle>
            </svg>
            <span style={{ marginTop: '22px', fontSize: '13px', fontWeight: 700, letterSpacing: '0.2em', color: '#2DD4BF' }}>THE SOLUTION</span>
            <h3 style={{ margin: '14px 0 0', fontSize: 'clamp(28px,3vw,44px)', lineHeight: 1.16, letterSpacing: '-0.02em', fontWeight: 700 }}>Rudrans connects the pieces.</h3>
            <p style={{ margin: '12px 0 0', fontSize: '17.5px', color: 'var(--ink2)' }}>One clearer picture of work.</p>
            <div style={{ position: 'relative', marginTop: '-14px', width: '100%', display: 'flex', justifyContent: 'center' }}>
              <img src="/rudrans/about-solution-bar.webp" width="2146" height="445" loading="lazy" decoding="async" alt="Streams of scattered activity converging from both sides into one clear Rudrans bar showing People, Time, Applications and Work Patterns" style={{ display: 'block', width: 'min(880px,100%)', height: 'auto', opacity: 0.62 }} />
            </div>
          </div>
        </div>
      </section>

      <section style={{ background: 'var(--bg2)', borderTop: '1px solid var(--line)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '84px 40px', ...(phone ? { padding: '84px 20px' } : {}) }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '16px' }}>
            <h2 style={{ margin: 0, fontSize: 'clamp(30px,3vw,46px)', lineHeight: 1.14, letterSpacing: '-0.02em', fontWeight: 700, textWrap: 'balance' } as React.CSSProperties}>Monitoring shouldn't<br />mean <span style={{ color: 'var(--blue)' }}>micromanaging.</span></h2>
            <p style={{ margin: 0, fontSize: '16.5px', lineHeight: 1.65, color: 'var(--ink2)', maxWidth: '600px', textWrap: 'pretty' } as React.CSSProperties}>Rudrans is built around a simple idea: organizations need visibility into work, while employees deserve clarity about what is being measured and why.</p>
          </div>
          {/* Keeps the PC arrangement at every width: OLD WAY | scale | RUDRANS
              WAY side by side — on small screens the columns turn fluid and the
              type steps down instead of stacking vertically. */}
          <div style={{ display: 'flex', flexWrap: phone ? 'wrap' as const : 'nowrap', alignItems: phone ? 'flex-start' : tablet ? 'center' : 'flex-start', gap: phone ? '20px 0' : 0, marginTop: '56px' }}>
            <div style={{ flex: phone ? '1 1 42%' : tablet ? '1 1 0' : 'none', width: tablet ? 'auto' : '200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: tablet ? '18px' : '30px', order: 1, paddingTop: '8px' }}>
              <span style={{ fontSize: phone ? '12.5px' : '15px', fontWeight: 700, letterSpacing: '0.14em', color: '#3D4B63', whiteSpace: 'nowrap' }}>OLD WAY</span>
              <span style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: phone ? '22px' : '32px' }}>
                <span style={{ position: 'absolute', left: '11.5px', top: '12px', bottom: '12px', width: 0, borderLeft: '1.5px dashed var(--line2)' }}></span>
                <span style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '14px' }}><span style={{ flex: 'none', width: '24px', height: '24px', borderRadius: '50%', background: '#EDF1F7', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1px', zIndex: 1 }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ink2)" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg></span><span style={{ fontSize: phone ? '13px' : '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--ink)' }}>Constant<br />check-ins</span></span>
                <span style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '14px' }}><span style={{ flex: 'none', width: '24px', height: '24px', borderRadius: '50%', background: '#EDF1F7', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1px', zIndex: 1 }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ink2)" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg></span><span style={{ fontSize: phone ? '13px' : '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--ink)' }}>"Are you<br />working?"</span></span>
                <span style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '14px' }}><span style={{ flex: 'none', width: '24px', height: '24px', borderRadius: '50%', background: '#EDF1F7', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1px', zIndex: 1 }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ink2)" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg></span><span style={{ fontSize: phone ? '13px' : '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--ink)' }}>Scattered<br />reports</span></span>
                <span style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '14px' }}><span style={{ flex: 'none', width: '24px', height: '24px', borderRadius: '50%', background: '#EDF1F7', border: '1px solid var(--line2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1px', zIndex: 1 }}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--ink2)" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg></span><span style={{ fontSize: phone ? '13px' : '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--ink)' }}>Decisions based<br />on assumptions</span></span>
              </span>
            </div>
            <div style={{ flex: phone ? '0 0 100%' : tablet ? '1.9 1 0' : '1 1 460px', minWidth: 0, order: phone ? 0 : 2, display: 'flex', justifyContent: 'center', alignItems: 'center', margin: tablet ? '0' : '0 -20px' }}>
              <img src="/rudrans/about-scale.webp" width="1672" height="941" loading="lazy" decoding="async" alt="Balance scale with the Rudrans shield at its center — scattered check-ins, reports and notes on one pan outweighed by a clear checklist of visibility, work patterns, context and evidence on the other" style={{ width: '100%', maxWidth: '820px', height: 'auto' }} />
            </div>
            <div style={{ flex: phone ? '1 1 42%' : tablet ? '1 1 0' : 'none', width: tablet ? 'auto' : '210px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: tablet ? '18px' : '30px', order: 3, paddingTop: '8px' }}>
              <span style={{ fontSize: phone ? '12.5px' : '15px', fontWeight: 700, letterSpacing: '0.14em', color: '#0FA48E', whiteSpace: 'nowrap' }}>RUDRANS WAY</span>
              <span style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: phone ? '22px' : '32px' }}>
                <span style={{ position: 'absolute', left: '11.5px', top: '12px', bottom: '12px', width: 0, borderLeft: '1.5px dashed rgba(15,164,142,0.4)' }}></span>
                <span style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '14px' }}><span style={{ flex: 'none', width: '24px', height: '24px', borderRadius: '50%', background: '#0FA48E', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1px', zIndex: 1, boxShadow: '0 4px 10px rgba(15,164,142,0.3)' }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></span><span style={{ fontSize: phone ? '13px' : '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--ink)' }}>Clear<br />visibility</span></span>
                <span style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '14px' }}><span style={{ flex: 'none', width: '24px', height: '24px', borderRadius: '50%', background: '#0FA48E', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1px', zIndex: 1, boxShadow: '0 4px 10px rgba(15,164,142,0.3)' }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></span><span style={{ fontSize: phone ? '13px' : '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--ink)' }}>Understand<br />work patterns</span></span>
                <span style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '14px' }}><span style={{ flex: 'none', width: '24px', height: '24px', borderRadius: '50%', background: '#0FA48E', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1px', zIndex: 1, boxShadow: '0 4px 10px rgba(15,164,142,0.3)' }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></span><span style={{ fontSize: phone ? '13px' : '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--ink)' }}>One source<br />of context</span></span>
                <span style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: '14px' }}><span style={{ flex: 'none', width: '24px', height: '24px', borderRadius: '50%', background: '#0FA48E', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1px', zIndex: 1, boxShadow: '0 4px 10px rgba(15,164,142,0.3)' }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"></path></svg></span><span style={{ fontSize: phone ? '13px' : '15px', fontWeight: 600, lineHeight: 1.4, color: 'var(--ink)' }}>Decisions based<br />on evidence</span></span>
              </span>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,230px),1fr))', gap: '22px 0', marginTop: '56px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '18px', padding: '0 28px', borderRight: '1px solid var(--line)' }}>
              <span style={{ flex: 'none', width: '72px', height: '72px', borderRadius: '50%', background: 'linear-gradient(160deg,#FFFFFF,#E9FBF7)', border: '1px solid rgba(15,164,142,0.25)', boxShadow: '0 10px 22px rgba(15,164,142,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="32" height="32" viewBox="0 0 24 24"><defs><linearGradient id="rd-pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2DD4BF"></stop><stop offset="1" stopColor="#0D9488"></stop></linearGradient></defs><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" fill="none" stroke="url(#rd-pg)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"></path><circle cx="12" cy="12" r="3.4" fill="url(#rd-pg)"></circle></svg></span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '21px', color: '#0FA48E' }}>01</span>
                <span style={{ fontWeight: 700, fontSize: '16.5px' }}>Transparency</span>
                <span style={{ fontSize: '13.5px', lineHeight: 1.55, color: 'var(--ink2)', textWrap: 'pretty', marginTop: '3px' } as React.CSSProperties}>People should know what is being measured.</span>
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '18px', padding: '0 28px', borderRight: '1px solid var(--line)' }}>
              <span style={{ flex: 'none', width: '72px', height: '72px', borderRadius: '50%', background: 'linear-gradient(160deg,#FFFFFF,#E9FBF7)', border: '1px solid rgba(15,164,142,0.25)', boxShadow: '0 10px 22px rgba(15,164,142,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="32" height="32" viewBox="0 0 24 24"><defs><linearGradient id="rd-pg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2DD4BF"></stop><stop offset="1" stopColor="#0D9488"></stop></linearGradient></defs><path d="M12 1.5 2.5 7 12 12.5 21.5 7 12 1.5z" fill="url(#rd-pg2)"></path><path d="M2.5 12 12 17.5 21.5 12l-2.6-1.5L12 14.4l-6.9-3.9L2.5 12z" fill="url(#rd-pg2)"></path><path d="M2.5 17 12 22.5 21.5 17l-2.6-1.5L12 19.4l-6.9-3.9L2.5 17z" fill="url(#rd-pg2)"></path></svg></span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '21px', color: '#0FA48E' }}>02</span>
                <span style={{ fontWeight: 700, fontSize: '16.5px' }}>Context</span>
                <span style={{ fontSize: '13.5px', lineHeight: 1.55, color: 'var(--ink2)', textWrap: 'pretty', marginTop: '3px' } as React.CSSProperties}>Activity means more when you understand the bigger picture.</span>
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '18px', padding: '0 28px', borderRight: '1px solid var(--line)' }}>
              <img src="/rudrans/trust-icon.webp" width="312" height="312" loading="lazy" decoding="async" alt="" style={{ flex: 'none', width: '72px', height: '72px', borderRadius: '50%', boxShadow: '0 10px 22px rgba(15,164,142,0.12)' }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '21px', color: '#0FA48E' }}>03</span>
                <span style={{ fontWeight: 700, fontSize: '16.5px' }}>Trust</span>
                <span style={{ fontSize: '13.5px', lineHeight: 1.55, color: 'var(--ink2)', textWrap: 'pretty', marginTop: '3px' } as React.CSSProperties}>Technology should support better management, not replace it.</span>
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '18px', padding: '0 28px', borderRight: 'none' }}>
              <span style={{ flex: 'none', width: '72px', height: '72px', borderRadius: '50%', background: 'linear-gradient(160deg,#FFFFFF,#E9FBF7)', border: '1px solid rgba(15,164,142,0.25)', boxShadow: '0 10px 22px rgba(15,164,142,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="32" height="32" viewBox="0 0 24 24"><defs><linearGradient id="rd-pg4" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2DD4BF"></stop><stop offset="1" stopColor="#0D9488"></stop></linearGradient></defs><path d="M21.5 7.5 13 16l-4.5-4.5L2.5 17" fill="none" stroke="url(#rd-pg4)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"></path><path d="M15.5 7.5h6v6" fill="none" stroke="url(#rd-pg4)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"></path></svg></span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '21px', color: '#0FA48E' }}>04</span>
                <span style={{ fontWeight: 700, fontSize: '16.5px' }}>Action</span>
                <span style={{ fontSize: '13.5px', lineHeight: 1.55, color: 'var(--ink2)', textWrap: 'pretty', marginTop: '3px' } as React.CSSProperties}>Data matters only when it helps someone make a better decision.</span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section style={{ background: 'var(--bg)', borderTop: '1px solid var(--line)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '84px 40px 72px', ...(phone ? { padding: '84px 20px 72px' } : {}) }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '16px' }}>
            <h2 style={{ margin: 0, fontSize: 'clamp(30px,3vw,46px)', lineHeight: 1.16, letterSpacing: '-0.02em', fontWeight: 700, textWrap: 'balance' } as React.CSSProperties}>Built by people who believe<br />software should <span style={{ background: 'linear-gradient(90deg,#14B8A6,#0D9488)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>keep getting better.</span></h2>
            <p style={{ margin: 0, fontSize: '16.5px', lineHeight: 1.65, color: 'var(--ink2)', maxWidth: '640px', textWrap: 'pretty' } as React.CSSProperties}>Rudrans is built by <a href="https://www.yugmasoft.com" target="_blank" rel="noopener" style={{ fontWeight: 600 }}>Yugma Soft</a> — not as a one-off monitoring tool, but as a product that evolves through real-world use, feedback and continuous improvement.</p>
          </div>
          {/* Desktop: labels float around the loop graphic (absolute).
              Tablet/phone: the calc(50% ± …) offsets collide, so the image goes
              on top and the five steps become a clean list below it. */}
          <div style={{ position: 'relative', maxWidth: tablet ? '760px' : '1240px', margin: '36px auto 12px', ...(tablet ? { display: 'grid', gridTemplateColumns: phone ? 'minmax(0,1fr)' : 'repeat(2,minmax(0,1fr))', gap: '20px 40px' } : {}) }}>
            <img src="/rudrans/about-loop.webp" width="1536" height="1024" loading="lazy" decoding="async" alt="Product loop — idea, build, use, learn, improve arranged in a circle of 3D arrows around a central analytics podium" style={{ display: 'block', width: tablet ? 'min(520px,100%)' : 'min(760px,72%)', margin: '0 auto', height: 'auto', ...(tablet ? { marginBottom: '14px', gridColumn: '1 / -1' } : {}) }} />
            {([
              { name: 'IDEA', text: 'A real workplace problem.', bar: '#2DD4BF', pos: { left: 'calc(50% + min(150px,14%))', top: '4%' } },
              { name: 'BUILD', text: 'Turn the problem into a usable product.', bar: '#14B8A6', pos: { left: 'calc(50% + min(330px,30%))', top: '34%' } },
              { name: 'USE', text: 'See how organizations actually use it.', bar: '#0D9488', pos: { left: 'calc(50% + min(230px,22%))', top: '82%' } },
              { name: 'LEARN', text: "Find what works — and what doesn't.", bar: '#14B8A6', pos: { right: 'calc(50% + min(250px,24%))', top: '83%' }, mirror: true },
              { name: 'IMPROVE', text: 'Ship the next, better version.', bar: '#0F766E', pos: { right: 'calc(50% + min(300px,28%))', top: '24%' }, mirror: true },
            ] as { name: string; text: string; bar: string; pos: React.CSSProperties; mirror?: boolean }[]).map((s) => (
              <span key={s.name} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', ...(tablet
                ? {}
                : { position: 'absolute' as const, width: 'max-content', maxWidth: 'min(210px,19vw)', ...s.pos, ...(s.mirror ? { flexDirection: 'row-reverse' as const, textAlign: 'right' as const } : {}) }) }}>
                <span style={{ flex: 'none', width: '4px', borderRadius: '2px', background: s.bar, alignSelf: 'stretch' }}></span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}><span style={{ fontWeight: 800, fontSize: '16px', letterSpacing: '0.06em' }}>{s.name}</span><span style={{ fontSize: '13.5px', lineHeight: 1.5, color: 'var(--ink2)' }}>{s.text}</span></span>
              </span>
            ))}
          </div>
        </div>
      </section>

      <section style={{ background: 'var(--bg2)', borderTop: '1px solid var(--line)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '84px 40px', ...(phone ? { padding: '84px 20px' } : {}) }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '18px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700, letterSpacing: '0.14em', color: '#0D9488', background: 'var(--blue-soft)', padding: '8px 18px', borderRadius: '999px' }}>BUILT BY YUGMA SOFT</span>
            <h2 style={{ margin: 0, fontSize: 'clamp(30px,3vw,46px)', lineHeight: 1.16, letterSpacing: '-0.02em', fontWeight: 700, textWrap: 'balance' } as React.CSSProperties}>Built to solve <span style={{ color: '#0D9488' }}>real problems.</span><br />Designed for <span style={{ color: '#0D9488' }}>real workplaces.</span></h2>
            <p style={{ margin: 0, fontSize: '16.5px', lineHeight: 1.7, color: 'var(--ink2)', maxWidth: '640px', textWrap: 'pretty' } as React.CSSProperties}>Rudrans is a product by <a href="https://www.yugmasoft.com" target="_blank" rel="noopener" style={{ fontWeight: 600 }}>Yugma Soft</a>, created to help organizations bring clarity, improve productivity and build a culture of trust through ethical and intelligent monitoring.</p>
            <span style={{ width: '44px', height: '2px', background: '#0D9488' }}></span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,250px),1fr))', gap: '18px', marginTop: '44px' }}>
            <HoverDiv base={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '28px 26px', display: 'flex', flexDirection: 'column', gap: '14px', transition: 'all 0.3s ease' }} hover={{ transform: 'translateY(-4px)', boxShadow: '0 18px 40px rgba(13,38,84,0.1)', border: '1px solid rgba(13,148,136,0.35)' }}>
              <span style={{ width: '52px', height: '52px', borderRadius: '14px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path></svg></span>
              <span style={{ fontWeight: 700, fontSize: '17.5px' }}>Built for every team</span>
              <span style={{ fontSize: '14px', lineHeight: 1.65, color: 'var(--ink2)', textWrap: 'pretty' } as React.CSSProperties}>From startups to large enterprises, Rudrans adapts to the way real teams work.</span>
            </HoverDiv>
            <HoverDiv base={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '28px 26px', display: 'flex', flexDirection: 'column', gap: '14px', transition: 'all 0.3s ease' }} hover={{ transform: 'translateY(-4px)', boxShadow: '0 18px 40px rgba(13,38,84,0.1)', border: '1px solid rgba(13,148,136,0.35)' }}>
              <span style={{ width: '52px', height: '52px', borderRadius: '14px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><rect x="9" y="10" width="6" height="5" rx="1"></rect><path d="M10 10V8.5a2 2 0 0 1 4 0V10"></path></svg></span>
              <span style={{ fontWeight: 700, fontSize: '17.5px' }}>Privacy by design</span>
              <span style={{ fontSize: '14px', lineHeight: 1.65, color: 'var(--ink2)', textWrap: 'pretty' } as React.CSSProperties}>We protect what matters. Rudrans is built with privacy, security and transparency at its core.</span>
            </HoverDiv>
            <HoverDiv base={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '28px 26px', display: 'flex', flexDirection: 'column', gap: '14px', transition: 'all 0.3s ease' }} hover={{ transform: 'translateY(-4px)', boxShadow: '0 18px 40px rgba(13,38,84,0.1)', border: '1px solid rgba(13,148,136,0.35)' }}>
              <span style={{ width: '52px', height: '52px', borderRadius: '14px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"></path></svg></span>
              <span style={{ fontWeight: 700, fontSize: '17.5px' }}>Actionable insights</span>
              <span style={{ fontSize: '14px', lineHeight: 1.65, color: 'var(--ink2)', textWrap: 'pretty' } as React.CSSProperties}>We turn data into clear insights that help leaders make better decisions.</span>
            </HoverDiv>
            <HoverDiv base={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: '18px', padding: '28px 26px', display: 'flex', flexDirection: 'column', gap: '14px', transition: 'all 0.3s ease' }} hover={{ transform: 'translateY(-4px)', boxShadow: '0 18px 40px rgba(13,38,84,0.1)', border: '1px solid rgba(13,148,136,0.35)' }}>
              <span style={{ width: '52px', height: '52px', borderRadius: '14px', background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#0D9488" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 7l-8.5 8.5-5-5L2 17"></path><path d="M15 7h6v6"></path></svg></span>
              <span style={{ fontWeight: 700, fontSize: '17.5px' }}>Continuously evolving</span>
              <span style={{ fontSize: '14px', lineHeight: 1.65, color: 'var(--ink2)', textWrap: 'pretty' } as React.CSSProperties}>We listen, learn and improve Rudrans every day based on real feedback.</span>
            </HoverDiv>
          </div>
        </div>
        <div style={{ background: 'linear-gradient(120deg,#04211E,#0A332F 55%,#0D453F)', marginTop: '64px' }}>
          <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '56px 40px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '28px', justifyContent: 'space-between', ...(phone ? { padding: '56px 20px' } : {}) }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0, maxWidth: '720px' }}>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 'clamp(22px,2.2vw,30px)', lineHeight: 1.25, color: '#FFFFFF', textWrap: 'balance' } as React.CSSProperties}>Every feature starts with a real workplace problem — and ends with a team working better.</span>
              <span style={{ fontSize: '15px', lineHeight: 1.6, color: 'rgba(255,255,255,0.65)' }}>That's the standard we hold ourselves to, release after release.</span>
            </span>
            <HoverLink to="/contact" base={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '10px', background: '#2DD4BF', color: '#04211E', fontWeight: 700, fontSize: '16px', padding: '15px 30px', borderRadius: '12px' }} hover={{ background: '#5EEAD4' }}>See Rudrans in action <span style={{ fontWeight: 400 }}>→</span></HoverLink>
          </div>
        </div>
      </section>

      </main>


      <footer style={{ background: '#05080D', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '64px 40px 48px', display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) repeat(4,minmax(0,1fr)) minmax(0,1.6fr)', gap: '38px', ...(tablet ? { gridTemplateColumns: 'repeat(2,minmax(0,1fr))' } : {}), ...(phone ? { gridTemplateColumns: 'minmax(0,1fr)', padding: '64px 20px 48px' } : {}) }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <img src="/rudrans/rudrans-logo.webp" width="1221" height="1289" loading="lazy" decoding="async" alt="Rudrans logo" style={{ width: '44px', height: '44px', objectFit: 'contain' }} />
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}><span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '20px', letterSpacing: '0.04em', color: '#FFFFFF' }}>RUDRANS</span><span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.3em', color: '#2DD4BF' }}>WORKFORCE MONITORING</span></span>
            </span>
            <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.75, color: 'rgba(255,255,255,0.6)', maxWidth: '280px' }}>Rudrans helps modern organizations monitor, secure and optimize their digital workforce with complete visibility and control.</p>
            <span style={{ display: 'flex', gap: '12px' }}>
              <HoverLink href="#" aria-label="LinkedIn" base={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }} hover={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V24h-4zM8.5 8h3.8v2.2h.1c.5-1 1.8-2.2 3.8-2.2 4 0 4.8 2.7 4.8 6.1V24h-4v-8.5c0-2-.04-4.7-2.9-4.7-2.9 0-3.3 2.2-3.3 4.5V24h-4z"></path></svg></HoverLink>
              <HoverLink href="#" aria-label="X" base={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }} hover={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.64 7.58H.46l8.6-9.83L0 1.15h7.59l5.24 6.93zm-1.29 19.5h2.04L6.49 3.24H4.3z"></path></svg></HoverLink>
              <HoverLink href="#" aria-label="YouTube" base={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }} hover={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4L15.8 12z"></path></svg></HoverLink>
              <HoverLink href="mailto:info@yugmasoft.com" aria-label="Email" base={{ width: '42px', height: '42px', borderRadius: '50%', background: 'rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2DD4BF', transition: 'all 0.25s ease' }} hover={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="m22 7-10 6L2 7"></path></svg></HoverLink>
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>PRODUCT</span>
            <HoverLink to="/" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Overview</HoverLink>
            <HoverLink to="/" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Features</HoverLink>
            <HoverLink to="/how-it-works" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>How It Works</HoverLink>
            <HoverLink to="/" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Integrations</HoverLink>
            <HoverLink to="/pricing" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Pricing</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Roadmap</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Changelog</HoverLink>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>SOLUTIONS</span>
            <HoverLink to="/" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Employee Monitoring</HoverLink>
            <HoverLink to="/" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Data Security</HoverLink>
            <HoverLink to="/" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Productivity Analytics</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Insider Threat Prevention</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Compliance Management</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Remote Work</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>For IT Teams</HoverLink>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>RESOURCES</span>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Blog</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Case Studies</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Ebooks &amp; Guides</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Webinars</HoverLink>
            <HoverLink to="/contact" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Help Center</HoverLink>
            <HoverLink to="/docs/integrations" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>API Documentation</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Release Notes</HoverLink>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', marginBottom: '5px' }}>COMPANY</span>
            <HoverLink to="/about" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>About Us</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Careers</HoverLink>
            <HoverLink href="https://srvora.com" target="_blank" rel="noopener" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Partners</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Newsroom</HoverLink>
            <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Trust Center</HoverLink>
            <HoverLink to="/contact" base={{ color: 'rgba(255,255,255,0.68)' }} hover={{ color: '#FFFFFF' }}>Contact Us</HoverLink>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: '34px' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF' }}>STAY UPDATED</span>
            <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.7, color: 'rgba(255,255,255,0.6)' }}>Subscribe to our newsletter for product updates, insights and best practices.</p>
            <span style={{ display: 'flex', alignItems: 'stretch', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', overflow: 'hidden' }}>
              <input type="email" placeholder="Enter your email" style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', padding: '15px 16px', fontSize: '13.5px', color: '#FFFFFF', fontFamily: "'IBM Plex Sans',sans-serif" }} />
              <HoverButton aria-label="Subscribe to newsletter" base={{ flex: 'none', width: '52px', border: 'none', cursor: 'pointer', background: '#0D9488', color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.25s ease' }} hover={{ background: '#14B8A6' }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></HoverButton>
            </span>
            <span style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', fontSize: '12.5px', lineHeight: 1.55, color: 'rgba(255,255,255,0.55)' }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2DD4BF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: '2px' }}><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>We respect your privacy. Unsubscribe anytime.</span>
          </div>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '22px 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '20px', flexWrap: 'wrap', ...(phone ? { padding: '22px 20px' } : {}) }}>
            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.55)' }}>© 2026 Rudrans · A <HoverLink href="https://www.yugmasoft.com" target="_blank" rel="noopener" base={{ color: 'rgba(255,255,255,0.75)', fontWeight: 600 }} hover={{ color: '#FFFFFF' }}>Yugma Soft</HoverLink> product. All rights reserved.</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 0, fontSize: '13px', flexWrap: 'wrap' }}>
              <HoverLink to="/legal/privacy" base={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }} hover={{ color: '#FFFFFF' }}>Privacy Policy</HoverLink>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
              <HoverLink to="/legal/terms" base={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }} hover={{ color: '#FFFFFF' }}>Terms of Service</HoverLink>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
              <HoverLink href="#" base={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }} hover={{ color: '#FFFFFF' }}>Data Processing Addendum</HoverLink>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13.5px', color: 'rgba(255,255,255,0.8)' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M2 12h20M12 3a15.3 15.3 0 0 1 0 18 15.3 15.3 0 0 1 0-18z"></path></svg>English <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"></path></svg></span>
          </div>
        </div>
      </footer>
    </div>
  );
}
