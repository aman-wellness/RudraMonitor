import { useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import MonitoringTabs, { type TabId } from './components/MonitoringTabs';
import ApplicationsTab from './components/ApplicationsTab';
import BrowserTab from './components/BrowserTab';
import LiveTab from './components/LiveTab';
import RemoteTab from './components/RemoteTab';
import VideosTab from './components/VideosTab';
import ScreenshotsTab from './components/ScreenshotsTab';
import IdleTab from './components/IdleTab';

export default function MonitoringPage() {
  const [activeTab, setActiveTab] = useState<TabId>('applications');

  return (
    <DashboardLayout>
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
            <button className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium transition-colors flex items-center gap-1.5">
              <span className="w-4 h-4 flex items-center justify-center">
                <i className="ri-refresh-line text-sm" />
              </span>
              Refresh
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <MonitoringTabs active={activeTab} onChange={setActiveTab} />

        {/* Tab Content */}
        {activeTab === 'applications' && <ApplicationsTab />}
        {activeTab === 'browser' && <BrowserTab />}
        {activeTab === 'live' && <LiveTab />}
        {activeTab === 'remote' && <RemoteTab />}
        {activeTab === 'videos' && <VideosTab />}
        {activeTab === 'screenshots' && <ScreenshotsTab />}
        {activeTab === 'idle' && <IdleTab />}
      </div>
    </DashboardLayout>
  );
}