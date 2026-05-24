import { useEffect, useMemo, useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import MonitoringTabs, { tabLabels, type TabId } from './components/MonitoringTabs';
import ApplicationsTab from './components/ApplicationsTab';
import BrowserTab from './components/BrowserTab';
import LiveTab from './components/LiveTab';
import RemoteTab from './components/RemoteTab';
import VideosTab from './components/VideosTab';
import ScreenshotsTab from './components/ScreenshotsTab';
import IdleTab from './components/IdleTab';
import UpgradeRequired from '@/components/UpgradeRequired';
import { useFeatures, type FeatureCode } from '@/lib/useFeatures';

// Map each monitoring tab to the feature flag it requires. Apps / Browser /
// Idle ride on the basic monitoring tier; Live / Remote / Videos / Screenshots
// are Professional or trial-only.
const TAB_FEATURE: Record<TabId, FeatureCode> = {
  applications: 'monitoring_basic',
  browser:      'monitoring_basic',
  live:         'live',
  remote:       'remote',
  videos:       'videos',
  screenshots:  'screenshots',
  idle:         'monitoring_basic',
};

export default function MonitoringPage() {
  const features = useFeatures();
  const has = (code: FeatureCode) => {
    switch (code) {
      case 'monitoring_basic': return features.monitoring_basic_enabled;
      case 'screenshots':      return features.screenshots_enabled;
      case 'videos':           return features.videos_enabled;
      case 'live':             return features.live_enabled;
      case 'remote':           return features.remote_enabled;
      case 'dlp':              return features.dlp_enabled;
      case 'employee_management': return features.em_enabled;
    }
  };

  // Visible tab set + reactive active-tab selection. If the user lands on a
  // tab their plan doesn't include (e.g. saved Remote tab in URL, then plan
  // downgraded) we fall back to the first allowed tab.
  const visibleTabs = useMemo(
    () => tabLabels.filter((t) => features.loading || has(TAB_FEATURE[t.id])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [features],
  );
  const [activeTab, setActiveTab] = useState<TabId>('applications');
  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (!visibleTabs.some((t) => t.id === activeTab)) {
      setActiveTab(visibleTabs[0].id);
    }
  }, [visibleTabs, activeTab]);

  // Hard gate the whole page if the org has zero monitoring entitlements
  // (covers the EM-only standalone plan). We still let the user see the
  // sidebar item disappear via DashboardLayout's feature filter, but a
  // direct URL hit should land on the upgrade screen.
  const noMonitoringAtAll =
    !features.loading
    && !features.monitoring_basic_enabled
    && !features.live_enabled
    && !features.remote_enabled
    && !features.videos_enabled
    && !features.screenshots_enabled;

  return (
    <DashboardLayout>
      {noMonitoringAtAll ? (
        <UpgradeRequired
          feature="Live Monitoring"
          icon="ri-computer-line"
          blurb="Your current plan doesn't include activity monitoring. Upgrade to Starter or Professional to track applications, browser usage, videos, and screenshots."
        />
      ) : (
        <div className="space-y-5 md:space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-xl md:text-2xl font-poppins font-bold text-white">
                Live Monitoring
              </h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Real-time tracking of applications, browser, videos, screenshots, and idle time
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Recording Active
              </span>
              <button
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                <span className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-refresh-line text-sm" />
                </span>
                Refresh
              </button>
            </div>
          </div>

          {/* Tab Navigation — filtered by entitlements */}
          <MonitoringTabs active={activeTab} onChange={setActiveTab} visibleIds={visibleTabs.map((t) => t.id)} />

          {/* Tab Content */}
          {activeTab === 'applications' && <ApplicationsTab />}
          {activeTab === 'browser' && <BrowserTab />}
          {activeTab === 'live' && <LiveTab />}
          {activeTab === 'remote' && <RemoteTab />}
          {activeTab === 'videos' && <VideosTab />}
          {activeTab === 'screenshots' && <ScreenshotsTab />}
          {activeTab === 'idle' && <IdleTab />}
        </div>
      )}
    </DashboardLayout>
  );
}
