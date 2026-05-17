// Public pricing tiers — kept in sync with the `plans` table seeds (starter-5,
// growth-25, scale-100 from migration 0013) and the actual product capabilities
// that ship today. Indian customers are billed in INR yearly; the USD column is
// shown next to it for international visitors.
//
// IMPORTANT: when you add a new plan or feature, update BOTH this file AND the
// plans table (admin → /admin/plans). The admin page is the operational source
// of truth; this file is the marketing surface and should never advertise a
// feature the product doesn't actually deliver.

export type PricingPlan = {
  id: 'starter' | 'growth' | 'scale';
  name: string;
  description: string;
  seatCount: number;
  priceInr: number;
  priceUsd: number;
  billingCycle: 'yearly';
  highlighted: boolean;
  /** Bullet list shown under the price. Keep tight (8-10 items max). */
  features: string[];
  cta: string;
};

export const pricingPlans: PricingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    description: 'For small teams getting started with workforce visibility',
    seatCount: 5,
    priceInr: 12000,
    priceUsd: 149,
    billingCycle: 'yearly',
    highlighted: false,
    features: [
      '5 agent licenses included',
      'Active app + browser URL tracking',
      'Automated screenshot capture',
      'System health (CPU, RAM, disk, network, battery)',
      'Idle detection with configurable threshold',
      'Real-time monitoring dashboard',
      'Departments & user invites',
      'DLP available as add-on',
      '30-day data retention',
      'Email support',
    ],
    cta: 'Start Free Trial',
  },
  {
    id: 'growth',
    name: 'Growth',
    description: 'Most popular — adds video, AI alerts and reports',
    seatCount: 25,
    priceInr: 54000,
    priceUsd: 649,
    billingCycle: 'yearly',
    highlighted: true,
    features: [
      '25 agent licenses included',
      'Everything in Starter',
      'Screenshots on app + URL change',
      'Video recording (configurable interval, 10-sec clips)',
      'Threshold alerts (CPU / RAM / disk overload)',
      'Custom productivity rules engine',
      'Activity reports + CSV exports',
      'DLP available as add-on',
      '90-day data retention',
      'Priority email support',
    ],
    cta: 'Start Free Trial',
  },
  {
    id: 'scale',
    name: 'Scale',
    description: 'For organisations with multi-team rollouts',
    seatCount: 100,
    priceInr: 180000,
    priceUsd: 2199,
    billingCycle: 'yearly',
    highlighted: false,
    features: [
      '100 agent licenses included',
      'Everything in Growth',
      'Unlimited screenshots + video clips',
      'Audit log for every admin action',
      'Per-agent capture controls (admin-toggleable)',
      'Silent auto-update for deployed agents',
      'Watchdog process resilience',
      'DLP available as add-on',
      '12-month data retention',
      'Phone + email support, dedicated onboarding',
    ],
    cta: 'Start Free Trial',
  },
];

/** Standalone Employee Management plan — for orgs that don't need monitoring. */
export const employeeManagementPlan = {
  id: 'em-unlimited' as const,
  name: 'Employee Management Unlimited',
  description: 'Full IT lifecycle suite — no monitoring agents required',
  seatCount: 9999,
  priceInr: 8500,
  priceUsd: 100,
  billingCycle: 'monthly' as const,
  features: [
    'Unlimited users (no per-seat cost)',
    'Microsoft 365 + Google Workspace one-click connect',
    'Provision new joiners (M365 mailbox + license + welcome email)',
    'Encrypted Credentials Vault with self-service request flow',
    'IT Hardware inventory with assignment history',
    'Groups & Teams bulk membership manager',
    'Reporting hierarchy + manager assignments',
    'Offboarding pipeline — 4 stages, auto NOC issuance',
    'Send-as your own mailbox (hr@yourcompany.com)',
    'Department + custom roles (Owner / Org Admin / Viewer)',
  ],
  cta: 'Start Free Trial',
};

/** Employee Management add-on — layers on top of any monitoring plan. */
export const employeeManagementAddon = {
  name: 'Employee Management add-on',
  priceInr: 8500,
  priceUsd: 100,
  billingCycle: 'monthly' as const,
  description: 'Add the full Employee Management suite on top of any Starter / Growth / Scale plan.',
  features: [
    'Unlimited users, no per-seat fee',
    'Everything in the standalone EM plan',
    'Stacks on top of your existing monitoring seats',
    'One bill — appears as a line item on your invoice',
  ],
};

/** DLP is an opt-in add-on — billed per-agent on top of any plan. */
export const dlpAddon = {
  name: 'Data Loss Prevention (DLP)',
  pricePerAgentInr: 250,
  pricePerAgentUsd: 3,
  description: 'AI-powered monitoring for data exfiltration through USB and personal email.',
  features: [
    'USB transfer detection — every file copied to removable drives is logged',
    'Personal mail tracking (Gmail, Yahoo, Outlook personal, Rediffmail, Proton, AOL)',
    'AI classifier with custom policy (Anthropic Claude → OpenAI fallback)',
    'Real-time email alerts via Microsoft Graph',
    'Authorized-domains whitelist for legit business email',
    'Per-event screenshot + SHA-256 file hash for audit',
    'Severity-tiered routing (low / medium / high / critical)',
  ],
};

/** Enterprise contact-only tier — bigger fleets, SLA, on-prem, custom retention. */
export const enterpriseTier = {
  name: 'Enterprise',
  description: 'Custom for >100 agents, on-prem or compliance-heavy deployments',
  features: [
    'Unlimited agents (custom seat negotiation)',
    'Everything in Scale',
    'Custom data retention (multi-year)',
    'On-premise deployment option',
    'SSO / SAML integration',
    'Dedicated account manager + SLA',
    'API access for custom integrations',
    'DLP at discounted per-agent pricing',
  ],
  cta: 'Contact Sales',
};
