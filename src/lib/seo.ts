// SEO for the Rudrans marketing site (src/pages/site/*).
//
// The site is a Vite SPA (no SSR), so per-route metadata is applied at
// runtime via useSeo() — Googlebot renders JS, and the static defaults in
// index.html + public/sitemap.xml + public/robots.txt cover the rest.
//
// Entity model (mirrors the live JSON-LD on yugmasoft.com / srvora.com):
//   Yugma Soft Pvt. Ltd. (parent company)
//     ├─ Rudrans  — workforce monitoring platform (this site, rudrans.com)
//     └─ Srvora   — on-demand IT services marketplace (srvora.com)

import { useEffect } from 'react';

export const SITE = {
  origin: 'https://rudrans.com',
  name: 'Rudrans',
  tagline: 'Workforce Monitoring',
  locale: 'en_IN',
  // Default social-share image (1200×630 recommended; dashboard shot reads well).
  ogImage: 'https://rudrans.com/rudrans/why-dashboard2.webp',
  logo: 'https://rudrans.com/rudrans/rudrans-logo.webp',
  email: 'info@yugmasoft.com',
} as const;

/* ------------------------------------------------------------------ *
 * Organization graph
 * ------------------------------------------------------------------ */

// Google Business Profile share links (sameAs). Rudrans' GBP is being
// created — add its share.google link here once it exists.
const GBP = {
  yugmaSoft: 'https://share.google/hBQukscwOmK9JxIWT',
  srvora: 'https://share.google/MDeYFELe0XEiNgRz1',
  // rudrans: 'https://share.google/…', // TODO: pending — user creates the Rudrans GBP
};

const SRVORA_ORG = {
  '@type': 'Organization',
  '@id': 'https://srvora.com/#organization',
  name: 'Srvora',
  url: 'https://srvora.com',
  description:
    'On-demand IT services marketplace connecting homes and businesses across India with verified independent engineers. Pay only on completion.',
  sameAs: [
    GBP.srvora,
    'https://www.linkedin.com/company/srvora',
    'https://www.instagram.com/srvora_official/',
    'https://x.com/srvora_official',
    'https://www.youtube.com/@srvora_official',
    'https://www.facebook.com/srvoraofficial',
  ],
};

const YUGMA_ORG = {
  '@type': 'Organization',
  '@id': 'https://yugmasoft.com/#organization',
  name: 'Yugma Soft',
  legalName: 'Yugma Soft Pvt. Ltd.',
  url: 'https://yugmasoft.com',
  email: 'info@yugmasoft.com',
  slogan: 'The engineering house behind Srvora and Rudrans',
  taxID: '03AACCY2627E1ZP',
  identifier: { '@type': 'PropertyValue', propertyID: 'CIN', value: 'U62099PB2026PTC069244' },
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'Ground Floor, Imperial Tower, D-186/C, Phase 8B, Industrial Area, Sector 74',
    addressLocality: 'Sahibzada Ajit Singh Nagar',
    addressRegion: 'Punjab',
    postalCode: '160055',
    addressCountry: 'IN',
  },
  sameAs: [GBP.yugmaSoft, 'https://www.linkedin.com/company/yugmasoft/'],
  owns: [{ '@id': 'https://rudrans.com/#organization' }, { '@id': 'https://srvora.com/#organization' }],
};

const RUDRANS_ORG = {
  '@type': 'Organization',
  '@id': 'https://rudrans.com/#organization',
  name: 'Rudrans',
  alternateName: 'Rudrans Workforce Monitoring',
  url: SITE.origin,
  logo: { '@type': 'ImageObject', url: SITE.logo },
  description:
    'Rudrans is a workforce monitoring platform that gives businesses real-time visibility into employee activity, productivity and security — live screens, activity timelines, DLP and device control in one dashboard.',
  email: SITE.email,
  parentOrganization: { '@id': 'https://yugmasoft.com/#organization' },
  areaServed: 'Worldwide',
  sameAs: [
    'https://yugmasoft.com',
    // TODO: add the Rudrans Google Business Profile share link once created.
  ],
};

const WEBSITE = {
  '@type': 'WebSite',
  '@id': `${SITE.origin}/#website`,
  name: 'Rudrans',
  url: SITE.origin,
  inLanguage: 'en-IN',
  publisher: { '@id': 'https://rudrans.com/#organization' },
};

const SOFTWARE_APP = {
  '@type': 'SoftwareApplication',
  '@id': `${SITE.origin}/#software`,
  name: 'Rudrans',
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'Employee Monitoring Software',
  operatingSystem: 'Windows, macOS, Ubuntu',
  url: SITE.origin,
  description:
    'Employee monitoring and workforce analytics: real-time application & website tracking, live screen view, screenshots, productivity insights, smart alerts, DLP and USB device control.',
  publisher: { '@id': 'https://rudrans.com/#organization' },
  offers: {
    '@type': 'AggregateOffer',
    priceCurrency: 'INR',
    lowPrice: '199',
    highPrice: '299',
    offerCount: '3',
    description: 'Per user per month. 7-day free trial, no credit card required. Enterprise: custom pricing.',
  },
};

const ORG_GRAPH = [RUDRANS_ORG, YUGMA_ORG, SRVORA_ORG, WEBSITE];

// FAQ rich-result data — must stay in sync with the FAQ accordion on /pricing.
const PRICING_FAQ = {
  '@type': 'FAQPage',
  mainEntity: [
    {
      q: 'Can I upgrade or downgrade my plan anytime?',
      a: 'Yes, you can upgrade or downgrade your plan at any time. Your billing will be adjusted accordingly, so you only pay for what you use.',
    },
    {
      q: 'Is there a free trial available?',
      a: 'Yes — every plan starts with a 7-day free trial with full access to all features. No credit card required to get started.',
    },
    {
      q: 'What payment methods do you accept?',
      a: 'We accept all major credit and debit cards, UPI and net banking. For Enterprise plans we also support invoicing and bank transfers.',
    },
    {
      q: 'Is my data secure with Rudrans?',
      a: 'Absolutely. All data is encrypted in transit and at rest, access is role-based, and you control data retention. Your monitoring data is never shared with third parties.',
    },
    {
      q: 'Do you offer discounts for yearly billing?',
      a: 'Yes — yearly billing saves you 20% compared to monthly billing. For larger teams, talk to our sales team about volume discounts.',
    },
  ].map(({ q, a }) => ({
    '@type': 'Question',
    name: q,
    acceptedAnswer: { '@type': 'Answer', text: a },
  })),
};

const breadcrumbs = (...crumbs: [string, string][]) => ({
  '@type': 'BreadcrumbList',
  itemListElement: crumbs.map(([name, path], i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name,
    item: `${SITE.origin}${path}`,
  })),
});

/* ------------------------------------------------------------------ *
 * Per-page metadata
 * ------------------------------------------------------------------ */

export interface PageSeo {
  path: string;
  title: string;
  description: string;
  keywords: string;
  ogImage?: string;
  jsonLd: object[];
}

export const PAGES = {
  home: {
    path: '/',
    title: 'Rudrans — Employee Monitoring & Workforce Analytics Software',
    description:
      'Rudrans gives businesses real-time visibility into employee activity, productivity and security — live screens, activity timelines, DLP and USB device control in one dashboard. Lightweight agent for Windows, macOS & Ubuntu. 7-day free trial.',
    keywords:
      'employee monitoring software, workforce monitoring, employee productivity tracking, live screen monitoring, DLP software, USB device control, activity tracking software, remote work monitoring, Rudrans',
    jsonLd: [SOFTWARE_APP, ...ORG_GRAPH],
  },
  about: {
    path: '/about',
    title: 'About Rudrans — Monitoring Without Micromanaging | Yugma Soft',
    description:
      'Rudrans is built by Yugma Soft on a simple idea: organizations need visibility into work, while employees deserve clarity about what is measured and why. Transparency, context, trust and action — made in India, built for the world.',
    keywords:
      'about Rudrans, Yugma Soft, ethical employee monitoring, transparent workforce monitoring, employee monitoring company India',
    jsonLd: [
      { '@type': 'AboutPage', '@id': `${SITE.origin}/about#webpage`, url: `${SITE.origin}/about`, name: 'About Rudrans', about: { '@id': 'https://rudrans.com/#organization' } },
      breadcrumbs(['Home', '/'], ['About', '/about']),
      ...ORG_GRAPH,
    ],
  },
  pricing: {
    path: '/pricing',
    title: 'Rudrans Pricing — Plans from ₹199/user/month | 7-Day Free Trial',
    description:
      'Simple per-user pricing for serious visibility. Starter ₹199, Professional ₹299 with screenshots, live screen view and DLP, or custom Enterprise plans. Yearly billing saves 20%. 7-day free trial, no credit card required.',
    keywords:
      'Rudrans pricing, employee monitoring software price, workforce monitoring plans, employee tracking software cost India, per user pricing',
    jsonLd: [SOFTWARE_APP, PRICING_FAQ, breadcrumbs(['Home', '/'], ['Pricing', '/pricing']), ...ORG_GRAPH],
  },
  contact: {
    path: '/contact',
    title: 'Contact Rudrans — Book a Demo or Talk to Sales',
    description:
      'Talk to the Rudrans team: book a personalized demo, get pricing for your team size, or ask about deployment, security and DLP. We respond within one business day.',
    keywords: 'contact Rudrans, book employee monitoring demo, workforce monitoring sales, Rudrans support',
    jsonLd: [
      {
        '@type': 'ContactPage',
        '@id': `${SITE.origin}/contact#webpage`,
        url: `${SITE.origin}/contact`,
        name: 'Contact Rudrans',
        about: { '@id': 'https://rudrans.com/#organization' },
      },
      breadcrumbs(['Home', '/'], ['Contact', '/contact']),
      ...ORG_GRAPH,
    ],
  },
  'how-it-works': {
    path: '/how-it-works',
    title: 'How Rudrans Works — From Activity to Action in 4 Steps',
    description:
      'A lightweight agent collects activity from apps, websites and devices; Rudrans processes it into productivity insights and security signals, so admins can monitor, analyze and act from one dashboard. See the full pipeline.',
    keywords:
      'how employee monitoring works, workforce monitoring pipeline, activity tracking agent, productivity analytics, employee monitoring features',
    jsonLd: [
      { '@type': 'WebPage', '@id': `${SITE.origin}/how-it-works#webpage`, url: `${SITE.origin}/how-it-works`, name: 'How Rudrans Works' },
      breadcrumbs(['Home', '/'], ['How it works', '/how-it-works']),
      SOFTWARE_APP,
      ...ORG_GRAPH,
    ],
  },
} satisfies Record<string, PageSeo>;

/* ------------------------------------------------------------------ *
 * Runtime application
 * ------------------------------------------------------------------ */

function upsertMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function upsertLink(rel: string, href: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

export function applySeo(page: PageSeo) {
  const url = `${SITE.origin}${page.path === '/' ? '' : page.path}`;
  const image = page.ogImage ?? SITE.ogImage;

  document.title = page.title;
  upsertMeta('name', 'description', page.description);
  upsertMeta('name', 'keywords', page.keywords);
  upsertMeta('name', 'robots', 'index, follow, max-image-preview:large');
  upsertLink('canonical', url);

  upsertMeta('property', 'og:type', 'website');
  upsertMeta('property', 'og:site_name', SITE.name);
  upsertMeta('property', 'og:locale', SITE.locale);
  upsertMeta('property', 'og:title', page.title);
  upsertMeta('property', 'og:description', page.description);
  upsertMeta('property', 'og:url', url);
  upsertMeta('property', 'og:image', image);

  upsertMeta('name', 'twitter:card', 'summary_large_image');
  upsertMeta('name', 'twitter:title', page.title);
  upsertMeta('name', 'twitter:description', page.description);
  upsertMeta('name', 'twitter:image', image);

  // One JSON-LD script per page, replaced wholesale on navigation.
  document.getElementById('rd-jsonld')?.remove();
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.id = 'rd-jsonld';
  script.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': page.jsonLd });
  document.head.appendChild(script);
}

/** Apply a marketing page's SEO metadata on mount. */
export function useSeo(page: keyof typeof PAGES) {
  useEffect(() => {
    applySeo(PAGES[page]);
  }, [page]);
}
