// Route-level feature gate. Pair with the `useFeatures` hook so routes can
// be declared like `<RequireFeature code="dlp">…</RequireFeature>` instead of
// every page reimplementing the same loading / upgrade-CTA dance.
//
// Trial orgs always pass through (the hook already encodes that). Once the
// trial ends, only orgs whose effective feature set includes `code` render
// the children; everyone else gets the UpgradeRequired CTA inside the normal
// dashboard chrome.

import type { ReactNode } from 'react';
import { useFeatures, type FeatureCode } from '@/lib/useFeatures';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import UpgradeRequired from './UpgradeRequired';

interface Props {
  code: FeatureCode;
  // Human-readable name for the upgrade CTA. Defaults to a humanised code
  // (`dlp` -> "DLP"), but pages can override for nicer copy.
  label?: string;
  icon?: string;
  blurb?: string;
  children: ReactNode;
}

const DEFAULT_LABELS: Record<FeatureCode, { label: string; icon: string; blurb: string }> = {
  monitoring_basic: {
    label: 'Activity Monitoring',
    icon:  'ri-computer-line',
    blurb: 'Monitor applications, browser, and idle time for every agent. Available on Starter and higher.',
  },
  screenshots: {
    label: 'Screenshots',
    icon:  'ri-image-line',
    blurb: 'Periodic screenshot capture is available on Professional and Enterprise plans.',
  },
  videos: {
    label: 'Video Recording',
    icon:  'ri-video-line',
    blurb: 'Periodic video clips of agent screens are available on Professional and Enterprise plans.',
  },
  live: {
    label: 'Live Monitoring',
    icon:  'ri-broadcast-line',
    blurb: 'Real-time WebRTC screen streaming is available on Professional and Enterprise plans.',
  },
  remote: {
    label: 'Remote Desktop',
    icon:  'ri-remote-control-2-line',
    blurb: 'Full remote control of an agent’s machine is available on Professional and Enterprise plans.',
  },
  dlp: {
    label: 'Data Loss Prevention',
    icon:  'ri-shield-keyhole-line',
    blurb: 'AI-powered DLP for USB transfers, email attachments, and clipboard exfiltration. Available on Professional or as an add-on to Starter.',
  },
  employee_management: {
    label: 'Employee Management',
    icon:  'ri-team-line',
    blurb: 'Provisioning, M365 / Google sync, credentials vault, hardware inventory, offboarding. Available on the EM plan, Enterprise, or as an add-on.',
  },
};

export default function RequireFeature({ code, label, icon, blurb, children }: Props) {
  const features = useFeatures();
  if (features.loading) {
    return (
      <DashboardLayout>
        <div className="text-sm text-gray-500 p-6">Loading subscription…</div>
      </DashboardLayout>
    );
  }

  const allowed = (() => {
    switch (code) {
      case 'monitoring_basic': return features.monitoring_basic_enabled;
      case 'screenshots':      return features.screenshots_enabled;
      case 'videos':           return features.videos_enabled;
      case 'live':             return features.live_enabled;
      case 'remote':           return features.remote_enabled;
      case 'dlp':              return features.dlp_enabled;
      case 'employee_management': return features.em_enabled;
    }
  })();

  if (allowed) return <>{children}</>;

  const defaults = DEFAULT_LABELS[code];
  return (
    <DashboardLayout>
      <UpgradeRequired
        feature={label ?? defaults.label}
        icon={icon ?? defaults.icon}
        blurb={blurb ?? defaults.blurb}
      />
    </DashboardLayout>
  );
}
