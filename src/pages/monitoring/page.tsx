import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import MonitoringTabs from './components/MonitoringTabs';
import { tabLabels, type TabId } from './components/tabs';
import ApplicationsTab from './components/ApplicationsTab';
import BrowserTab from './components/BrowserTab';
import LiveTab from './components/LiveTab';
import RemoteTab from './components/RemoteTab';
import VideosTab from './components/VideosTab';
import ScreenshotsTab from './components/ScreenshotsTab';
import IdleTab from './components/IdleTab';
import UpgradeRequired from '@/components/UpgradeRequired';
import { RefreshBus } from './components/refreshBus';
import { useAgents } from '@/lib/dataHooks';
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
  const { agents, loading: agentsLoading } = useAgents();
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

  // The active tab parks its data-refetch here so the header button can call
  // it — see refreshBus for why this isn't a prop.
  const tabRefresh = useRef<(() => void) | null>(null);
  const register = useCallback((fn: (() => void) | null) => { tabRefresh.current = fn; }, []);
  const [refreshing, setRefreshing] = useState(false);
  const refreshNow = () => {
    if (!tabRefresh.current) return;
    setRefreshing(true);
    tabRefresh.current();
    // The hooks flip their own `loading`; this is purely so the icon spins long
    // enough to read as a response to the click.
    window.setTimeout(() => setRefreshing(false), 600);
  };

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

  // Real fleet state, not a decorative pill. The old header showed a green
  // pulsing "Recording Active" unconditionally — it sat there claiming to
  // record while the Live tab right below it said "No online agents".
  const reporting = agents.filter((a) => a.status !== 'offline').length;
  const total = agents.length;

  return (
    <DashboardLayout>
      {noMonitoringAtAll ? (
        <UpgradeRequired
          feature="Live Monitoring"
          icon="ri-computer-line"
          blurb="Your current plan doesn't include activity monitoring. Upgrade to Starter or Professional to track applications, browser usage, videos, and screenshots."
        />
      ) : (
        <div className="dash min-w-0 max-w-full">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <h1 className="num" style={{ fontSize: 17 }}>Live monitoring</h1>
              {!agentsLoading && (
                <span
                  className={`inline-flex items-center gap-1.5 text-[11px] ${
                    reporting > 0 ? 't-success' : 't3'
                  }`}
                  title="Agents that have checked in recently"
                >
                  <span className={`live-dot ${reporting > 0 ? '' : 'is-off'}`} />
                  {total === 0
                    ? 'No agents enrolled'
                    : reporting === 0
                      ? `0 of ${total} reporting`
                      : `${reporting} of ${total} reporting`}
                </span>
              )}
            </div>

            <button
              onClick={refreshNow}
              disabled={!tabRefresh.current || refreshing}
              className="chip chip-quiet text-[10.5px]"
              title="Refetch this tab"
            >
              <i className={`ri-refresh-line ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          {/* Tab Navigation — filtered by entitlements */}
          <div className="mb-3">
            <MonitoringTabs
              active={activeTab}
              onChange={setActiveTab}
              visibleIds={visibleTabs.map((t) => t.id)}
            />
          </div>

          <RefreshBus.Provider value={register}>
            {activeTab === 'applications' && <ApplicationsTab />}
            {activeTab === 'browser' && <BrowserTab />}
            {activeTab === 'live' && <LiveTab />}
            {activeTab === 'remote' && <RemoteTab />}
            {activeTab === 'videos' && <VideosTab />}
            {activeTab === 'screenshots' && <ScreenshotsTab />}
            {activeTab === 'idle' && <IdleTab />}
          </RefreshBus.Provider>
        </div>
      )}
    </DashboardLayout>
  );
}
