import '@/styles/rudrans-site.css';
import { useState, useEffect } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import SiteHeader from '../SiteHeader';
import { useSeo } from '@/lib/seo';

/* ---- small hover helpers (port of style-hover) ---- */
type HoverAProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  hoverStyle?: React.CSSProperties;
};
function HoverA({ hoverStyle, style, children, ...rest }: HoverAProps) {
  const [h, setH] = useState(false);
  return (
    <a
      {...rest}
      style={{ ...style, ...(h && hoverStyle ? hoverStyle : {}) }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
    >
      {children}
    </a>
  );
}

type HoverLinkProps = LinkProps & { hoverStyle?: React.CSSProperties };
function HoverLink({ hoverStyle, style, children, ...rest }: HoverLinkProps) {
  const [h, setH] = useState(false);
  return (
    <Link
      {...rest}
      style={{ ...style, ...(h && hoverStyle ? hoverStyle : {}) }}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
    >
      {children}
    </Link>
  );
}

type HoverButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  hoverStyle?: React.CSSProperties;
};
function HoverButton({ hoverStyle, style, children, ...rest }: HoverButtonProps) {
  const [h, setH] = useState(false);
  return (
    <button
      {...rest}
      style={{ ...style, ...(h && hoverStyle ? hoverStyle : {}) }}
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

export default function Contact() {
  useSeo('contact');
  const tablet = useMax(900);
  const phone = useMax(600);
  const emptyForm = {
    name: '',
    job: '',
    email: '',
    company: '',
    teamsize: '',
    interest: '',
    message: '',
  };
  const [form, setForm] = useState(emptyForm);
  const [sent, setSent] = useState(false);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSent(true);
    setForm(emptyForm);
    setTimeout(() => setSent(false), 6000);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    background: 'var(--card)',
    border: '1px solid var(--line2)',
    borderRadius: '12px',
    padding: '15px 16px 15px 45px',
    fontSize: '14.5px',
    color: 'var(--ink)',
    fontFamily: "'IBM Plex Sans',sans-serif",
    outline: 'none',
    transition: 'border-color 0.2s ease',
  };
  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: 'none',
    color: 'var(--ink2)',
  };
  const iconStyle: React.CSSProperties = {
    position: 'absolute',
    left: '15px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
  };
  const chevronStyle: React.CSSProperties = {
    position: 'absolute',
    right: '16px',
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
  };

  return (
    <div className="rd-site">
      <SiteHeader active="contact" />

      <main style={{ display: 'contents' }}>

      <section
        id="top"
        style={{
          position: 'relative',
          overflow: 'hidden',
          background: 'linear-gradient(180deg,var(--bg2),var(--bg))',
        }}
      >
        <div
          style={{
            position: 'relative',
            maxWidth: '1400px',
            margin: '0 auto',
            padding: phone ? '64px 20px 72px' : '64px 40px 72px',
            display: 'grid',
            gridTemplateColumns: tablet ? '1fr' : 'minmax(0,1fr) minmax(0,1.15fr)',
            gap: '48px',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: '24px',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.16em',
                color: 'var(--blue)',
                background: 'var(--blue-soft)',
                border: '1px solid var(--line)',
                padding: '8px 16px',
                borderRadius: '999px',
              }}
            >
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  background: 'var(--green)',
                  animation: 'rd-pulse 2s ease-in-out infinite',
                }}
              ></span>
              LET’S CONNECT
            </span>
            <h1
              style={{
                margin: 0,
                fontSize: 'clamp(34px,3.9vw,58px)',
                lineHeight: '1.13',
                letterSpacing: '-0.03em',
                fontWeight: 700,
                textWrap: 'balance',
              }}
            >
              Let’s start a conversation that drives{' '}
              <span
                style={{
                  background: 'linear-gradient(90deg,#0D9488,#2DD4BF)',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                better work.
              </span>
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: '17.5px',
                lineHeight: '1.7',
                color: 'var(--ink2)',
                maxWidth: '460px',
                textWrap: 'pretty',
              }}
            >
              Our team is here to answer your questions, understand your needs, and help you make
              Rudrans work for your team.
            </p>
          </div>
          <div style={{ position: 'relative', minWidth: 0 }}>
            <img
              src="/rudrans/contact-hero6.webp" width="1536" height="1024" fetchPriority="high" decoding="async"
              alt="Get in touch — a clipped note card with a Rudrans pen, paper plane doodle and checkmarks for quick responses, real solutions, built for your team"
              style={{ display: 'block', width: '100%', height: 'auto' }}
            />
          </div>
        </div>
      </section>

      <section
        id="form"
        style={{ background: 'var(--bg2)', borderTop: '1px solid var(--line)' }}
      >
        <div
          style={{
            maxWidth: '1400px',
            margin: '0 auto',
            padding: phone ? '80px 20px' : '80px 40px',
            display: 'grid',
            gridTemplateColumns: tablet ? '1fr' : 'minmax(0,1fr) minmax(0,0.92fr)',
            gap: '56px',
            alignItems: 'start',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: '20px',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.16em',
                color: 'var(--blue)',
                background: 'var(--blue-soft)',
                padding: '8px 16px',
                borderRadius: '999px',
              }}
            >
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  background: 'var(--green)',
                  animation: 'rd-pulse 2s ease-in-out infinite',
                }}
              ></span>
              GET IN TOUCH
            </span>
            <h2
              style={{
                margin: 0,
                fontSize: 'clamp(30px,3.2vw,46px)',
                lineHeight: '1.15',
                letterSpacing: '-0.025em',
                fontWeight: 700,
                textWrap: 'balance',
              }}
            >
              <span
                style={{
                  background: 'linear-gradient(90deg,#0D9488,#2DD4BF)',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                Let’s talk
              </span>{' '}
              about how Rudrans can work for you.
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: '16px',
                lineHeight: '1.7',
                color: 'var(--ink2)',
                maxWidth: '500px',
                textWrap: 'pretty',
              }}
            >
              Have a question, need a demo, or want to explore a partnership? Fill out the form and
              our team will get back to you shortly.
            </p>
            <form
              onSubmit={submit}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
                width: '100%',
                marginTop: '8px',
              }}
            >
              <span
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))',
                  gap: '14px',
                }}
              >
                <span style={{ position: 'relative', display: 'block' }}>
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--ink3)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={iconStyle}
                  >
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                  </svg>
                  <input
                    required
                    name="name"
                    placeholder="Full name*"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    style={inputStyle}
                  />
                </span>
                <span style={{ position: 'relative', display: 'block' }}>
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--ink3)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={iconStyle}
                  >
                    <rect x="2" y="7" width="20" height="14" rx="2"></rect>
                    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
                  </svg>
                  <input
                    name="job"
                    placeholder="Job title"
                    value={form.job}
                    onChange={(e) => setForm({ ...form, job: e.target.value })}
                    style={inputStyle}
                  />
                </span>
              </span>
              <span
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))',
                  gap: '14px',
                }}
              >
                <span style={{ position: 'relative', display: 'block' }}>
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--ink3)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={iconStyle}
                  >
                    <rect x="2" y="4" width="20" height="16" rx="2"></rect>
                    <path d="m22 7-10 6L2 7"></path>
                  </svg>
                  <input
                    required
                    type="email"
                    name="email"
                    placeholder="Work email*"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    style={inputStyle}
                  />
                </span>
                <span style={{ position: 'relative', display: 'block' }}>
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--ink3)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={iconStyle}
                  >
                    <rect x="4" y="2" width="16" height="20" rx="2"></rect>
                    <path d="M9 6h1M14 6h1M9 10h1M14 10h1M9 14h1M14 14h1M9 22v-4h6v4"></path>
                  </svg>
                  <input
                    required
                    name="company"
                    placeholder="Company name*"
                    value={form.company}
                    onChange={(e) => setForm({ ...form, company: e.target.value })}
                    style={inputStyle}
                  />
                </span>
              </span>
              <span style={{ position: 'relative', display: 'block' }}>
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--ink3)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={iconStyle}
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
                <select
                  name="teamsize"
                  value={form.teamsize}
                  onChange={(e) => setForm({ ...form, teamsize: e.target.value })}
                  style={selectStyle}
                >
                  <option value="">Team size</option>
                  <option>1–10</option>
                  <option>11–50</option>
                  <option>51–200</option>
                  <option>201–1000</option>
                  <option>1000+</option>
                </select>
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--ink3)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={chevronStyle}
                >
                  <path d="m6 9 6 6 6-6"></path>
                </svg>
              </span>
              <span style={{ position: 'relative', display: 'block' }}>
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--ink3)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={iconStyle}
                >
                  <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                  <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                  <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                  <rect x="14" y="14" width="7" height="7" rx="1"></rect>
                </svg>
                <select
                  name="interest"
                  value={form.interest}
                  onChange={(e) => setForm({ ...form, interest: e.target.value })}
                  style={selectStyle}
                >
                  <option value="">I’m interested in</option>
                  <option>Product demo</option>
                  <option>Pricing &amp; plans</option>
                  <option>Partnership</option>
                  <option>Technical support</option>
                  <option>Something else</option>
                </select>
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--ink3)"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={chevronStyle}
                >
                  <path d="m6 9 6 6 6-6"></path>
                </svg>
              </span>
              <span style={{ position: 'relative', display: 'block' }}>
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--ink3)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ position: 'absolute', left: '15px', top: '18px', pointerEvents: 'none' }}
                >
                  <path d="M12 20h9"></path>
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
                </svg>
                <textarea
                  required
                  name="message"
                  placeholder="How can we help you?"
                  rows={5}
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  style={{ ...inputStyle, resize: 'vertical', minHeight: '120px' }}
                ></textarea>
              </span>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '20px',
                  flexWrap: 'wrap',
                  marginTop: '4px',
                }}
              >
                <HoverButton
                  type="submit"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '9px',
                    background: 'var(--blue)',
                    color: '#FFFFFF',
                    fontWeight: 700,
                    fontSize: '15.5px',
                    padding: '15px 28px',
                    borderRadius: '12px',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: "'IBM Plex Sans',sans-serif",
                    transition: 'all 0.25s ease',
                  }}
                  hoverStyle={{ background: 'var(--blue2)', transform: 'translateY(-2px)' }}
                >
                  Send message <span style={{ fontWeight: 400 }}>→</span>
                </HoverButton>
                {sent && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '14px',
                      fontWeight: 700,
                      color: 'var(--green)',
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                      <path d="M22 4 12 14.01l-3-3"></path>
                    </svg>
                    Message sent — we’ll be in touch!
                  </span>
                )}
                {!sent && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '13.5px',
                      color: 'var(--ink2)',
                    }}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#0D9488"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2"></rect>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                    </svg>
                    Your information is protected
                  </span>
                )}
              </span>
            </form>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              background: 'linear-gradient(180deg,#E9F4F1,#F0F6F8)',
              border: '1px solid var(--line)',
              borderRadius: '24px',
              overflow: 'hidden',
            }}
          >
            <img
              src="/rudrans/contact-form-visual.webp" width="684" height="502" loading="lazy" decoding="async"
              alt="3D scene — an Overview dashboard with active employees, productive time and security alerts, an activity timeline, a teal envelope, phone button, chat bubble and a plant"
              style={{ display: 'block', width: '100%', height: 'auto' }}
            />
            <div
              style={{
                background: 'var(--card)',
                borderRadius: '18px',
                margin: '0 18px 18px',
                padding: '28px 30px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '28px 44px',
                alignItems: 'flex-start',
                boxShadow: '0 10px 26px rgba(13,38,84,0.06)',
              }}
            >
              <div
                style={{
                  flex: tablet ? '0 0 auto' : '1.3 1 280px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}),
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '22px',
                }}
              >
                <span style={{ fontWeight: 700, fontSize: '16.5px' }}>Other ways to reach us</span>
                <span style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
                  <span
                    style={{
                      flex: 'none',
                      width: '44px',
                      height: '44px',
                      borderRadius: '12px',
                      background: 'var(--blue-soft)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <svg
                      width="19"
                      height="19"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#0D9488"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="2" y="4" width="20" height="16" rx="2"></rect>
                      <path d="m22 7-10 6L2 7"></path>
                    </svg>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <span style={{ fontWeight: 700, fontSize: '14.5px' }}>Email us</span>
                    <span style={{ fontSize: '13.5px', lineHeight: '1.55', color: 'var(--ink2)' }}>
                      hello@rudrans.com
                    </span>
                  </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
                  <span
                    style={{
                      flex: 'none',
                      width: '44px',
                      height: '44px',
                      borderRadius: '12px',
                      background: 'var(--blue-soft)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <svg
                      width="19"
                      height="19"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#0D9488"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path>
                    </svg>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <span style={{ fontWeight: 700, fontSize: '14.5px' }}>Call us</span>
                    <span style={{ fontSize: '13.5px', lineHeight: '1.55', color: 'var(--ink2)' }}>
                      +91 98765 43210
                    </span>
                  </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
                  <span
                    style={{
                      flex: 'none',
                      width: '44px',
                      height: '44px',
                      borderRadius: '12px',
                      background: 'var(--blue-soft)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <svg
                      width="19"
                      height="19"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#0D9488"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"></path>
                      <circle cx="12" cy="10" r="3"></circle>
                    </svg>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <span style={{ fontWeight: 700, fontSize: '14.5px' }}>Visit us</span>
                    <span style={{ fontSize: '13.5px', lineHeight: '1.55', color: 'var(--ink2)' }}>
                      Cabin No. 2, First Floor, E-110, Phase 7, Industrial Area, Sector 73, Sahibzada
                      Ajit Singh Nagar, Punjab 160055
                    </span>
                  </span>
                </span>
              </div>
              <div
                style={{
                  flex: tablet ? '0 0 auto' : '1 1 190px', ...(tablet ? { width: '100%', boxSizing: 'border-box' as const } : {}),
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  paddingTop: '6px',
                }}
              >
                <span
                  style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '50%',
                    background: 'var(--blue-soft)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <svg
                    width="27"
                    height="27"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#0D9488"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="13.5" cy="12" r="7.5"></circle>
                    <path d="M13.5 8.2V12l2.6 1.8"></path>
                    <path d="M2 9h4.5M1 12h3.5M2 15h4.5"></path>
                  </svg>
                </span>
                <span style={{ fontSize: '14px', lineHeight: '1.6', color: 'var(--ink2)' }}>
                  We usually reply within a few hours.
                </span>
                <span style={{ fontWeight: 700, fontSize: '14.5px', lineHeight: '1.5' }}>
                  Let’s make work more visible, together.{' '}
                  <span style={{ color: '#0D9488' }}>❤</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      </main>

      <footer
        style={{ background: '#05080D', borderTop: '1px solid rgba(255,255,255,0.07)' }}
      >
        <div
          style={{
            maxWidth: '1400px',
            margin: '0 auto',
            padding: phone ? '64px 20px 48px' : '64px 40px 48px',
            display: 'grid',
            gridTemplateColumns: phone
              ? '1fr'
              : tablet
                ? 'repeat(2,minmax(0,1fr))'
                : 'minmax(0,1.5fr) repeat(4,minmax(0,1fr)) minmax(0,1.6fr)',
            gap: '38px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <img
                src="/rudrans/rudrans-logo.webp" width="1221" height="1289" loading="lazy" decoding="async"
                alt="Rudrans logo"
                style={{ width: '44px', height: '44px', objectFit: 'contain' }}
              />
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: '1.15' }}>
                <span
                  style={{
                    fontFamily: "'Space Grotesk',sans-serif",
                    fontWeight: 700,
                    fontSize: '20px',
                    letterSpacing: '0.04em',
                    color: '#FFFFFF',
                  }}
                >
                  RUDRANS
                </span>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    letterSpacing: '0.3em',
                    color: '#2DD4BF',
                  }}
                >
                  WORKFORCE MONITORING
                </span>
              </span>
            </span>
            <p
              style={{
                margin: 0,
                fontSize: '14px',
                lineHeight: '1.75',
                color: 'rgba(255,255,255,0.6)',
                maxWidth: '280px',
              }}
            >
              Rudrans helps modern organizations monitor, secure and optimize their digital
              workforce with complete visibility and control.
            </p>
            <span style={{ display: 'flex', gap: '12px' }}>
              <HoverA
                href="#"
                aria-label="LinkedIn"
                style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.07)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#2DD4BF',
                  transition: 'all 0.25s ease',
                }}
                hoverStyle={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V24h-4zM8.5 8h3.8v2.2h.1c.5-1 1.8-2.2 3.8-2.2 4 0 4.8 2.7 4.8 6.1V24h-4v-8.5c0-2-.04-4.7-2.9-4.7-2.9 0-3.3 2.2-3.3 4.5V24h-4z"></path>
                </svg>
              </HoverA>
              <HoverA
                href="#"
                aria-label="X"
                style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.07)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#2DD4BF',
                  transition: 'all 0.25s ease',
                }}
                hoverStyle={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.64 7.58H.46l8.6-9.83L0 1.15h7.59l5.24 6.93zm-1.29 19.5h2.04L6.49 3.24H4.3z"></path>
                </svg>
              </HoverA>
              <HoverA
                href="#"
                aria-label="YouTube"
                style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.07)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#2DD4BF',
                  transition: 'all 0.25s ease',
                }}
                hoverStyle={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4L15.8 12z"></path>
                </svg>
              </HoverA>
              <HoverA
                href="mailto:info@yugmasoft.com"
                aria-label="Email"
                style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.07)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#2DD4BF',
                  transition: 'all 0.25s ease',
                }}
                hoverStyle={{ background: 'rgba(45,212,191,0.18)', color: '#5EEAD4' }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="4" width="20" height="16" rx="2"></rect>
                  <path d="m22 7-10 6L2 7"></path>
                </svg>
              </HoverA>
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span
              style={{
                fontSize: '12.5px',
                fontWeight: 700,
                letterSpacing: '0.14em',
                color: '#2DD4BF',
                marginBottom: '5px',
              }}
            >
              PRODUCT
            </span>
            <HoverLink to="/" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Overview
            </HoverLink>
            <HoverLink
              to="/"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              Features
            </HoverLink>
            <HoverLink
              to="/how-it-works"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              How It Works
            </HoverLink>
            <HoverLink
              to="/"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              Integrations
            </HoverLink>
            <HoverLink
              to="/pricing"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              Pricing
            </HoverLink>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Roadmap
            </HoverA>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Changelog
            </HoverA>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span
              style={{
                fontSize: '12.5px',
                fontWeight: 700,
                letterSpacing: '0.14em',
                color: '#2DD4BF',
                marginBottom: '5px',
              }}
            >
              SOLUTIONS
            </span>
            <HoverLink
              to="/"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              Employee Monitoring
            </HoverLink>
            <HoverLink
              to="/"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              Data Security
            </HoverLink>
            <HoverLink
              to="/"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              Productivity Analytics
            </HoverLink>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Insider Threat Prevention
            </HoverA>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Compliance Management
            </HoverA>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Remote Work
            </HoverA>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              For IT Teams
            </HoverA>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span
              style={{
                fontSize: '12.5px',
                fontWeight: 700,
                letterSpacing: '0.14em',
                color: '#2DD4BF',
                marginBottom: '5px',
              }}
            >
              RESOURCES
            </span>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Blog
            </HoverA>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Case Studies
            </HoverA>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Ebooks &amp; Guides
            </HoverA>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Webinars
            </HoverA>
            <HoverLink
              to="/contact"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              Help Center
            </HoverLink>
            <HoverLink
              to="/docs/integrations"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              API Documentation
            </HoverLink>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Release Notes
            </HoverA>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '14px' }}>
            <span
              style={{
                fontSize: '12.5px',
                fontWeight: 700,
                letterSpacing: '0.14em',
                color: '#2DD4BF',
                marginBottom: '5px',
              }}
            >
              COMPANY
            </span>
            <HoverLink
              to="/about"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              About Us
            </HoverLink>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Careers
            </HoverA>
            <HoverA
              href="https://srvora.com"
              target="_blank"
              rel="noopener"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              Partners
            </HoverA>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Newsroom
            </HoverA>
            <HoverA href="#" style={{ color: 'rgba(255,255,255,0.68)' }} hoverStyle={{ color: '#FFFFFF' }}>
              Trust Center
            </HoverA>
            <HoverLink
              to="/contact"
              style={{ color: 'rgba(255,255,255,0.68)' }}
              hoverStyle={{ color: '#FFFFFF' }}
            >
              Contact Us
            </HoverLink>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '18px',
              borderLeft: tablet ? 'none' : '1px solid rgba(255,255,255,0.08)',
              paddingLeft: tablet ? 0 : '34px',
            }}
          >
            <span
              style={{
                fontSize: '12.5px',
                fontWeight: 700,
                letterSpacing: '0.14em',
                color: '#2DD4BF',
              }}
            >
              STAY UPDATED
            </span>
            <p
              style={{
                margin: 0,
                fontSize: '14px',
                lineHeight: '1.7',
                color: 'rgba(255,255,255,0.6)',
              }}
            >
              Subscribe to our newsletter for product updates, insights and best practices.
            </p>
            <span
              style={{
                display: 'flex',
                alignItems: 'stretch',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '12px',
                overflow: 'hidden',
              }}
            >
              <input
                type="email"
                placeholder="Enter your email"
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  padding: '15px 16px',
                  fontSize: '13.5px',
                  color: '#FFFFFF',
                  fontFamily: "'IBM Plex Sans',sans-serif",
                }}
              />
              <HoverButton
                aria-label="Subscribe to newsletter"
                style={{
                  flex: 'none',
                  width: '52px',
                  border: 'none',
                  cursor: 'pointer',
                  background: '#0D9488',
                  color: '#FFFFFF',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'background 0.25s ease',
                }}
                hoverStyle={{ background: '#14B8A6' }}
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14M13 6l6 6-6 6"></path>
                </svg>
              </HoverButton>
            </span>
            <span
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '9px',
                fontSize: '12.5px',
                lineHeight: '1.55',
                color: 'rgba(255,255,255,0.55)',
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#2DD4BF"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flex: 'none', marginTop: '2px' }}
              >
                <rect x="3" y="11" width="18" height="11" rx="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              We respect your privacy. Unsubscribe anytime.
            </span>
          </div>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div
            style={{
              maxWidth: '1400px',
              margin: '0 auto',
              padding: phone ? '22px 20px' : '22px 40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '20px',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.55)' }}>
              © 2026 Rudrans · A{' '}
              <HoverA
                href="https://www.yugmasoft.com"
                target="_blank"
                rel="noopener"
                style={{ color: 'rgba(255,255,255,0.75)', fontWeight: 600 }}
                hoverStyle={{ color: '#FFFFFF' }}
              >
                Yugma Soft
              </HoverA>{' '}
              product. All rights reserved.
            </span>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 0,
                fontSize: '13px',
                flexWrap: 'wrap',
              }}
            >
              <HoverLink
                to="/legal/privacy"
                style={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }}
                hoverStyle={{ color: '#FFFFFF' }}
              >
                Privacy Policy
              </HoverLink>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
              <HoverLink
                to="/legal/terms"
                style={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }}
                hoverStyle={{ color: '#FFFFFF' }}
              >
                Terms of Service
              </HoverLink>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>
              <HoverA
                href="#"
                style={{ color: 'rgba(255,255,255,0.65)', padding: '0 18px' }}
                hoverStyle={{ color: '#FFFFFF' }}
              >
                Data Processing Addendum
              </HoverA>
            </span>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '13.5px',
                color: 'rgba(255,255,255,0.8)',
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(255,255,255,0.7)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9"></circle>
                <path d="M2 12h20M12 3a15.3 15.3 0 0 1 0 18 15.3 15.3 0 0 1 0-18z"></path>
              </svg>
              English{' '}
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(255,255,255,0.6)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6"></path>
              </svg>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
