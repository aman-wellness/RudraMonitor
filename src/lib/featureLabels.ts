// Canonical feature-code → human-readable bullet labels. Used by PlanGrid
// to render feature lists straight from a plan's `features_included` array.
//
// Each canonical code expands to one or more bullets, so EM's single
// `employee_management` code becomes the 4-5 lines a customer expects to
// see ("M365 sync", "credentials vault", etc.). Legacy codes
// (`productivity_reports`, `video_recording`, …) are mapped onto the v2
// canonical equivalents.

export const FEATURE_BULLETS: Record<string, string[]> = {
  monitoring_basic: [
    'Application & browser tracking',
    'Idle / active time detection',
    'Productivity rules & reports',
    'Daily, weekly summaries',
  ],
  screenshots: ['Periodic screenshots'],
  videos: ['Video clip recording'],
  live: ['Live WebRTC monitoring'],
  remote: ['Remote desktop control'],
  dlp: ['AI-powered DLP (USB / email / clipboard)'],
  employee_management: [
    'M365 + Google Workspace sync',
    'Groups, teams, managers',
    'Credentials vault + self-service',
    'IT hardware inventory',
    '4-stage offboarding pipeline',
  ],

  // Legacy code aliases — see migration 0070_org_features_canonical.sql
  productivity_reports: ['Application & browser tracking', 'Productivity rules & reports'],
  video_recording: ['Periodic screenshots', 'Video clip recording'],
  ai_alerts: ['Smart AI alerts'],
};

// Single-line label, used for table cells / pill summaries.
export const FEATURE_LABEL_ONE_LINER: Record<string, string> = {
  monitoring_basic: 'Activity monitoring',
  screenshots: 'Screenshots',
  videos: 'Video recording',
  live: 'Live monitoring',
  remote: 'Remote desktop',
  dlp: 'DLP (USB / Email)',
  employee_management: 'Employee Management',
  productivity_reports: 'Productivity reports',
  video_recording: 'Video recording',
  ai_alerts: 'Smart AI alerts',
};

// Order canonical features should appear in when listed for a plan.
// Anything not in this order falls to the end alphabetically.
export const FEATURE_ORDER = [
  'monitoring_basic',
  'screenshots',
  'videos',
  'live',
  'remote',
  'dlp',
  'employee_management',
] as const;

export function expandFeatureBullets(codes: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const sorted = [...(codes ?? [])].sort((a, b) => {
    const ai = (FEATURE_ORDER as readonly string[]).indexOf(a);
    const bi = (FEATURE_ORDER as readonly string[]).indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  for (const code of sorted) {
    const bullets = FEATURE_BULLETS[code] ?? [code];
    for (const b of bullets) {
      if (!seen.has(b)) { seen.add(b); out.push(b); }
    }
  }
  return out;
}
