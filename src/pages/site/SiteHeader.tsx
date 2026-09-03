// Shared fixed header for the Rudrans marketing site (all 5 public pages).
//
// Desktop (>900px): identical to the original Claude-Design export — logo,
// centered nav, Partner Login / Login / Start free trial on the right.
// Mobile (≤900px): single 66px row with a hamburger; nav + auth actions live
// in a dropdown panel under the bar (the old wrapping header grew ~200px
// tall while position:fixed, hiding the top of every page behind it).
//
// Hover styling comes from .rd-hdr-* classes in rudrans-site.css — CSS
// :hover avoids the React "shorthand border vs borderColor" style clash the
// old inline HoverLink helpers triggered.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

type NavKey = 'about' | 'pricing' | 'contact' | 'how-it-works';

function useMax(px: number) {
  const [m, setM] = useState(() => window.matchMedia(`(max-width:${px}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${px}px)`);
    const on = () => setM(mq.matches); on();
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, [px]);
  return m;
}

const NAV: { label: string; to: string; key: NavKey }[] = [
  { label: 'About', to: '/about', key: 'about' },
  { label: 'Pricing', to: '/pricing', key: 'pricing' },
  { label: 'Contact', to: '/contact', key: 'contact' },
  { label: 'How it works', to: '/how-it-works', key: 'how-it-works' },
];

export default function SiteHeader({ active, home }: { active?: NavKey; home?: boolean }) {
  const mobile = useMax(900);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const logoInner = (
    <>
      <img src="/rudrans/rudrans-logo.webp" alt="Rudrans logo" width="1221" height="1289" decoding="async" style={{ width: '40px', height: '40px', objectFit: 'contain' }} />
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
        <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: '19px', letterSpacing: '-0.01em' }}>Rudrans</span>
        <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.14em', color: 'var(--ink3)' }}>WORKFORCE MONITORING</span>
      </span>
    </>
  );
  const logoStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--ink)' };

  const cta = home
    ? <a href="#pricing" className="rd-hdr-cta" onClick={close} style={mobile ? { flex: 1, justifyContent: 'center' } : undefined}>Start free trial <span style={{ fontWeight: 400 }}>→</span></a>
    : <Link to="/signup" className="rd-hdr-cta" onClick={close} style={mobile ? { flex: 1, justifyContent: 'center' } : undefined}>Start free trial <span style={{ fontWeight: 400 }}>→</span></Link>;

  return (
    <>
      <header style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, background: 'var(--bg2)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', padding: mobile ? '8px 20px' : '8px 40px', minHeight: '66px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: mobile ? 'nowrap' : 'wrap', boxSizing: 'border-box' }}>
          {home
            ? <a href="#top" style={logoStyle}>{logoInner}</a>
            : <Link to="/" style={logoStyle}>{logoInner}</Link>}

          {!mobile && (
            <nav style={{ display: 'flex', alignItems: 'center', gap: 'clamp(12px,1.8vw,26px)', fontSize: '14px', fontWeight: 600, whiteSpace: 'nowrap', flexWrap: 'wrap' }}>
              {NAV.map((n) => (
                <Link key={n.key} to={n.to} className={`rd-hdr-nav-a${active === n.key ? ' rd-active' : ''}`}>{n.label}</Link>
              ))}
            </nav>
          )}

          {!mobile && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Link to="/partner/login" className="rd-hdr-partner">Partner Login</Link>
              <Link to="/login" className="rd-hdr-login">Login</Link>
              {cta}
            </div>
          )}

          {mobile && (
            <button
              aria-label={open ? 'Close menu' : 'Open menu'}
              onClick={() => setOpen((o) => !o)}
              style={{ background: 'var(--card)', border: '1.5px solid var(--line2)', borderRadius: '10px', width: '42px', height: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--ink)', flex: 'none', padding: 0 }}
            >
              {open
                ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
                : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>}
            </button>
          )}
        </div>

        {mobile && open && (
          <div style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)', padding: '8px 20px 18px', display: 'flex', flexDirection: 'column', boxShadow: '0 22px 34px rgba(13,38,84,0.12)' }}>
            {NAV.map((n) => (
              <Link key={n.key} to={n.to} onClick={close}
                className={`rd-hdr-nav-a${active === n.key ? ' rd-active' : ''}`}
                style={{ padding: '13px 2px', fontSize: '15px', borderBottom: '1px solid var(--line)' }}>
                {n.label}
              </Link>
            ))}
            <Link to="/partner/login" onClick={close} className="rd-hdr-partner" style={{ padding: '13px 2px', fontSize: '15px' }}>Partner Login</Link>
            <div style={{ display: 'flex', gap: '10px', paddingTop: '10px' }}>
              <Link to="/login" onClick={close} className="rd-hdr-login" style={{ flex: 1, justifyContent: 'center' }}>Login</Link>
              {cta}
            </div>
          </div>
        )}
      </header>
      <div style={{ height: '67px' }} />
    </>
  );
}
