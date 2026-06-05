// Shared layout for all documentation pages. Renders a sticky TOC sidebar +
// the doc body. Pages pass in their section headings via the `sections` prop
// so the TOC stays in sync with the actual content order.

import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';

export type DocSection = { id: string; label: string };

export default function DocsLayout({
  title, subtitle, sections, children, accent = 'emerald',
}: {
  title: string;
  subtitle: string;
  sections: DocSection[];
  children: React.ReactNode;
  accent?: 'emerald' | 'violet' | 'cyan' | 'amber';
}) {
  const loc = useLocation();
  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? '');

  // Track which section is currently in view using IntersectionObserver so
  // the TOC highlights the right entry as the user scrolls.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          const sorted = visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          setActiveId(sorted[0].target.id);
        }
      },
      { rootMargin: '-80px 0px -70% 0px' },
    );
    sections.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sections]);

  const accentColors = {
    emerald: 'text-emerald-400 border-emerald-500',
    violet:  'text-violet-400 border-violet-500',
    cyan:    'text-cyan-400 border-cyan-500',
    amber:   'text-amber-400 border-amber-500',
  }[accent];

  return (
    <div className="min-h-screen bg-dark-950 text-gray-200">
      {/* Top bar */}
      <header className="border-b border-dark-800 bg-dark-900/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
              <i className="ri-shield-check-line text-lg" />
            </span>
            <span className="text-white font-poppins font-bold text-lg">Wellness Extract</span>
            <span className="text-gray-500 text-xs ml-2 hidden sm:inline">Documentation</span>
          </Link>
          <nav className="flex items-center gap-3 text-xs">
            <Link to="/docs/user-guide" className={loc.pathname === '/docs/user-guide' ? 'text-emerald-400' : 'text-gray-400 hover:text-white'}>User Guide</Link>
            <Link to="/docs/integrations" className={loc.pathname === '/docs/integrations' ? 'text-cyan-400' : 'text-gray-400 hover:text-white'}>Integrations</Link>
            <Link to="/docs/partner-guide" className={loc.pathname === '/docs/partner-guide' ? 'text-violet-400' : 'text-gray-400 hover:text-white'}>Partner Guide</Link>
            <Link to="/" className="text-gray-400 hover:text-white">← Back to Wellness Extract</Link>
          </nav>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-8">
        {/* TOC sidebar */}
        <aside className="lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-6rem)] overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">On this page</p>
          <nav className="space-y-0.5 border-l border-dark-700">
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`}
                className={`block pl-3 py-1 text-xs border-l-2 -ml-px transition-colors ${
                  activeId === s.id
                    ? `${accentColors} font-medium`
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}>
                {s.label}
              </a>
            ))}
          </nav>
        </aside>

        {/* Body */}
        <main className="min-w-0">
          <header className="mb-8">
            <h1 className="text-3xl md:text-4xl font-poppins font-bold text-white mb-2">{title}</h1>
            <p className="text-gray-400">{subtitle}</p>
          </header>
          <article className="prose-we space-y-10">
            {children}
          </article>
          <footer className="mt-16 pt-8 border-t border-dark-800 text-xs text-gray-500">
            <p>Last updated: 16 May 2026 · Need help? Email support@wellnessextract.com</p>
          </footer>
        </main>
      </div>
    </div>
  );
}

// ============== Reusable doc components ==============

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-2xl font-poppins font-semibold text-white mb-3">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-lg font-poppins font-semibold text-white mt-6 mb-2">{title}</h3>
      <div className="space-y-2 text-sm text-gray-300 leading-relaxed">{children}</div>
    </div>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-300 leading-relaxed">{children}</p>;
}

export function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2 list-decimal list-inside text-sm text-gray-300">
      {items.map((it, i) => <li key={i} className="leading-relaxed">{it}</li>)}
    </ol>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-1.5 list-disc list-inside text-sm text-gray-300">
      {items.map((it, i) => <li key={i} className="leading-relaxed">{it}</li>)}
    </ul>
  );
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-dark-900 border border-dark-700 rounded-lg p-3 text-[11px] font-mono text-gray-300 overflow-x-auto leading-relaxed">
      {children}
    </pre>
  );
}

export function Callout({ kind = 'info', title, children }: { kind?: 'info' | 'warn' | 'success'; title?: string; children: React.ReactNode }) {
  const map = {
    info:    'bg-cyan-500/10 border-cyan-500/30 text-cyan-100',
    warn:    'bg-amber-500/10 border-amber-500/30 text-amber-100',
    success: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-100',
  };
  const icon = { info: 'ri-information-line', warn: 'ri-error-warning-line', success: 'ri-checkbox-circle-line' }[kind];
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${map[kind]}`}>
      <div className="flex items-start gap-2">
        <i className={`${icon} mt-0.5`} />
        <div>
          {title && <p className="font-semibold mb-1">{title}</p>}
          <div>{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Shot({ caption }: { caption: string }) {
  return (
    <div className="bg-dark-900 border border-dashed border-dark-600 rounded-lg p-8 text-center">
      <i className="ri-image-line text-3xl text-gray-600" />
      <p className="text-[11px] text-gray-500 mt-2">Screenshot · {caption}</p>
    </div>
  );
}

export function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-1 sm:gap-3 text-sm border-b border-dark-800 py-2">
      <span className="text-gray-500">{k}</span>
      <span className="text-gray-200">{v}</span>
    </div>
  );
}
