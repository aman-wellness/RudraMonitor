import { Particles, ParticlesProvider } from '@tsparticles/react';
import { loadSlim } from '@tsparticles/slim';
import type { Engine, ISourceOptions } from '@tsparticles/engine';

// Stable init function — must be reference-equal across renders or
// ParticlesProvider throws ("init callback must be stable").
const initParticles = async (engine: Engine) => { await loadSlim(engine); };

// Six animated background presets for the org chart canvas. All free,
// GPU-friendly, and customizable via colorAccent. tsparticles powers the
// "network" preset; the rest are pure CSS keyframes for zero overhead.

export type BackgroundKey =
  | 'default'      // dark gradient (no animation)
  | 'aurora'       // animated multi-radial gradient
  | 'network'      // tsparticles connected dots
  | 'orbs'         // floating glow orbs (CSS)
  | 'waves'        // diagonal animated waves (SVG)
  | 'mesh'         // gradient mesh that slowly drifts
  | 'custom';      // solid custom color

export const BACKGROUND_OPTIONS: { key: BackgroundKey; label: string; icon: string; desc: string }[] = [
  { key: 'default', label: 'Dark',    icon: 'ri-moon-line',            desc: 'Clean dark gradient' },
  { key: 'aurora',  label: 'Aurora',  icon: 'ri-aurora-line',          desc: 'Animated rainbow radial mist' },
  { key: 'network', label: 'Network', icon: 'ri-base-station-line',    desc: 'Connected particles (tsparticles)' },
  { key: 'orbs',    label: 'Orbs',    icon: 'ri-bubble-chart-line',    desc: 'Floating glow blobs' },
  { key: 'waves',   label: 'Waves',   icon: 'ri-water-flash-line',     desc: 'Diagonal flowing waves' },
  { key: 'mesh',    label: 'Mesh',    icon: 'ri-shape-line',           desc: 'Gradient mesh drift' },
  { key: 'custom',  label: 'Solid',   icon: 'ri-paint-fill',           desc: 'Pick your own color' },
];

interface Props {
  preset: BackgroundKey;
  customColor: string;          // hex for the 'custom' preset
  accent: string;               // accent hex used by tsparticles + orb glow
}

export default function AnimatedBackground({ preset, customColor, accent }: Props) {
  // ── tsparticles 'network' preset ────────────────────────────────────────
  if (preset === 'network') {
    const accentRgb = hexToRgb(accent);
    const options: ISourceOptions = {
      fullScreen: { enable: false },
      background: { color: 'transparent' },
      detectRetina: true,
      fpsLimit: 60,
      interactivity: {
        events: {
          onHover: { enable: true, mode: 'grab' },
        },
        modes: {
          grab: { distance: 180, links: { opacity: 0.5 } },
        },
      },
      particles: {
        number: { value: 60, density: { enable: true } },
        color: { value: accent },
        links: {
          enable: true,
          color: accent,
          distance: 140,
          opacity: 0.25,
          width: 1,
        },
        opacity: { value: { min: 0.2, max: 0.5 } },
        size: { value: { min: 1, max: 3 } },
        move: {
          enable: true,
          speed: 0.6,
          direction: 'none',
          random: true,
          outModes: { default: 'out' },
        },
      },
    };
    return (
      <div className="org-bg org-bg--network" style={{ background: `radial-gradient(circle at center, rgba(${accentRgb},0.06) 0%, #0a0f1c 70%)` }}>
        <ParticlesProvider init={initParticles}>
          <Particles id="org-chart-particles" options={options} />
        </ParticlesProvider>
      </div>
    );
  }

  // ── Pure CSS presets ────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS_BG}</style>
      {preset === 'default' && <div className="org-bg org-bg--default" />}
      {preset === 'aurora'  && (
        <div className="org-bg org-bg--aurora">
          <div className="org-bg__aurora-blob org-bg__aurora-blob--1" style={{ background: accent }} />
          <div className="org-bg__aurora-blob org-bg__aurora-blob--2" />
          <div className="org-bg__aurora-blob org-bg__aurora-blob--3" />
        </div>
      )}
      {preset === 'orbs' && (
        <div className="org-bg org-bg--orbs">
          {[...Array(6)].map((_, i) => (
            <div key={i} className={`org-bg__orb org-bg__orb--${i}`} style={{ background: i % 2 === 0 ? accent : '#5535a0' }} />
          ))}
        </div>
      )}
      {preset === 'waves' && (
        <div className="org-bg org-bg--waves">
          <svg viewBox="0 0 1200 800" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="wave-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity="0.4" />
                <stop offset="100%" stopColor={accent} stopOpacity="0.05" />
              </linearGradient>
            </defs>
            <path className="org-bg__wave org-bg__wave--1" d="M0,400 C300,300 600,500 900,400 C1100,330 1200,420 1200,420 L1200,800 L0,800 Z" fill="url(#wave-grad)" />
            <path className="org-bg__wave org-bg__wave--2" d="M0,500 C400,420 700,580 1100,470 C1200,440 1200,500 1200,500 L1200,800 L0,800 Z" fill="url(#wave-grad)" opacity="0.6" />
            <path className="org-bg__wave org-bg__wave--3" d="M0,620 C300,560 800,680 1200,580 L1200,800 L0,800 Z" fill="url(#wave-grad)" opacity="0.4" />
          </svg>
        </div>
      )}
      {preset === 'mesh' && (
        <div
          className="org-bg org-bg--mesh"
          style={{
            background: `
              radial-gradient(at 20% 25%, ${accent}33 0px, transparent 40%),
              radial-gradient(at 75% 80%, #5535a033 0px, transparent 45%),
              radial-gradient(at 80% 20%, #1d5fa633 0px, transparent 50%),
              radial-gradient(at 15% 75%, #17604433 0px, transparent 45%),
              #0a0f1c
            `,
          }}
        />
      )}
      {preset === 'custom' && (
        <div className="org-bg org-bg--custom" style={{ background: customColor }} />
      )}
    </>
  );
}

function hexToRgb(hex: string): string {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return '52, 211, 153';
  const [r, g, b] = m.map((x) => parseInt(x, 16));
  return `${r}, ${g}, ${b}`;
}

const CSS_BG = `
.org-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.org-bg--network { pointer-events: auto; }
.org-bg--default { background: linear-gradient(135deg, #0a0f1c 0%, #0d1426 50%, #0a0f1c 100%); }
.org-bg--custom { transition: background 0.4s ease; }

/* ── Aurora ───────────────────────────────────────────────────────────── */
.org-bg--aurora { background: radial-gradient(ellipse at top, #0d1426 0%, #050811 70%); }
@keyframes aurora-drift-1 { 0%,100% { transform: translate(-20%, -10%) scale(1); } 50% { transform: translate(10%, 20%) scale(1.3); } }
@keyframes aurora-drift-2 { 0%,100% { transform: translate(20%, 30%) scale(1.1); } 50% { transform: translate(-15%, -10%) scale(0.9); } }
@keyframes aurora-drift-3 { 0%,100% { transform: translate(50%, 60%) scale(1.2); } 50% { transform: translate(30%, 40%) scale(1); } }
.org-bg__aurora-blob {
  position: absolute;
  width: 600px; height: 600px;
  border-radius: 50%;
  filter: blur(120px);
  opacity: 0.35;
  mix-blend-mode: screen;
}
.org-bg__aurora-blob--1 { top: -10%; left: -10%;  animation: aurora-drift-1 22s ease-in-out infinite; }
.org-bg__aurora-blob--2 { top: 30%;  left: 50%;   background: #5535a0; animation: aurora-drift-2 28s ease-in-out infinite; }
.org-bg__aurora-blob--3 { top: 60%;  left: 10%;   background: #1d5fa6; animation: aurora-drift-3 30s ease-in-out infinite; }

/* ── Orbs ─────────────────────────────────────────────────────────────── */
.org-bg--orbs { background: radial-gradient(circle at center, #0d1426 0%, #050811 100%); }
@keyframes orb-float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  25%      { transform: translate(40px, -30px) scale(1.05); }
  50%      { transform: translate(-30px, 40px) scale(0.95); }
  75%      { transform: translate(20px, 20px) scale(1.1); }
}
.org-bg__orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(60px);
  opacity: 0.25;
  mix-blend-mode: screen;
}
.org-bg__orb--0 { width: 300px; height: 300px; top: 10%;  left: 5%;   animation: orb-float 18s ease-in-out infinite; }
.org-bg__orb--1 { width: 220px; height: 220px; top: 30%;  left: 70%;  animation: orb-float 22s ease-in-out infinite 2s; }
.org-bg__orb--2 { width: 260px; height: 260px; top: 60%;  left: 20%;  animation: orb-float 26s ease-in-out infinite 4s; }
.org-bg__orb--3 { width: 200px; height: 200px; top: 75%;  left: 80%;  animation: orb-float 20s ease-in-out infinite 6s; }
.org-bg__orb--4 { width: 280px; height: 280px; top: 5%;   left: 45%;  animation: orb-float 24s ease-in-out infinite 1s; }
.org-bg__orb--5 { width: 240px; height: 240px; top: 50%;  left: 55%;  animation: orb-float 28s ease-in-out infinite 3s; }

/* ── Waves ────────────────────────────────────────────────────────────── */
.org-bg--waves { background: linear-gradient(180deg, #050811 0%, #0a0f1c 100%); }
.org-bg--waves svg { position: absolute; bottom: 0; left: 0; width: 100%; height: 100%; }
@keyframes wave-drift-1 { 0%,100% { transform: translateX(0); } 50% { transform: translateX(-3%); } }
@keyframes wave-drift-2 { 0%,100% { transform: translateX(0); } 50% { transform: translateX(4%); } }
@keyframes wave-drift-3 { 0%,100% { transform: translateX(0); } 50% { transform: translateX(-5%); } }
.org-bg__wave--1 { animation: wave-drift-1 14s ease-in-out infinite; }
.org-bg__wave--2 { animation: wave-drift-2 18s ease-in-out infinite; }
.org-bg__wave--3 { animation: wave-drift-3 22s ease-in-out infinite; }

/* ── Mesh ─────────────────────────────────────────────────────────────── */
@keyframes mesh-drift {
  0%, 100% { background-position: 20% 25%, 75% 80%, 80% 20%, 15% 75%, 0% 0%; }
  50%      { background-position: 25% 30%, 70% 75%, 75% 25%, 20% 70%, 0% 0%; }
}
.org-bg--mesh {
  background-size: 100% 100% !important;
  animation: mesh-drift 30s ease-in-out infinite;
}

/* tsparticles canvas — pin to bg layer */
#org-chart-particles {
  position: absolute !important;
  inset: 0;
}
`;
