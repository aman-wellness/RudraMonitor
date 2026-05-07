import { useParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import AgentHeader from './components/AgentHeader';
import DateFilter from './components/DateFilter';
import AgentStatCards from './components/AgentStatCards';
import QuickStats from './components/QuickStats';
import TimelineChart from './components/TimelineChart';
import BottomTabs from './components/BottomTabs';
import TimePerApp from './components/TimePerApp';
import CaptureControls from './components/CaptureControls';
import { detailBottomTabs, type DetailTabId } from '@/mocks/agentDetail';
import { useAgentDetail } from '@/lib/useAgentDetail';
import { useSignedScreenshotUrls } from '@/lib/dataHooks';
import { supabase } from '@/lib/supabase';

void detailBottomTabs;

const formatTime = (iso: string) => {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

const formatRelative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const [activeTab, setActiveTab] = useState<DetailTabId>('applications');
  const { agent, activity, alerts, loading, notFound, refresh } = useAgentDetail(agentId);

  const updateCaptureSettings = async (screenshots: boolean, videos: boolean) => {
    if (!agentId) return;
    const { error } = await supabase
      .from('agents')
      .update({ screenshots_enabled: screenshots, videos_enabled: videos })
      .eq('id', agentId);
    if (error) throw error;
    await refresh();
  };

  const screenshotPaths = useMemo(
    () => activity.filter((a) => a.activity_type === 'screenshot').map((a) => a.screenshot_url).filter((p): p is string => !!p),
    [activity],
  );
  const signedScreenshots = useSignedScreenshotUrls(screenshotPaths);

  if (loading && !agent) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[400px] text-sm text-gray-500">Loading agent…</div>
      </DashboardLayout>
    );
  }

  if (notFound || !agent) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <span className="w-16 h-16 flex items-center justify-center mx-auto mb-4 text-gray-600">
              <i className="ri-error-warning-line text-4xl" />
            </span>
            <h2 className="text-lg font-bold text-white mb-2">Agent Not Found</h2>
            <p className="text-sm text-gray-500">The agent you are looking for does not exist or you do not have access.</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const counts: Record<string, number | null> = {
    applications: agent.appsUsed,
    browser: agent.sitesVisited,
    videos: 0,
    screenshots: agent.screenshotsCount,
    timeline: null,
    alerts: agent.alertsCount,
    system: null,
    ai: null,
  };

  const browserRows = activity.filter((a) => a.activity_type === 'browser');
  const screenshotRows = activity.filter((a) => a.activity_type === 'screenshot');

  return (
    <DashboardLayout>
      <div className="space-y-4 min-w-0 max-w-full overflow-x-hidden">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-dashboard-line" /></span>
            Dashboard
          </span>
          <i className="ri-arrow-right-s-line text-gray-600" />
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-computer-line" /></span>
            Agents
          </span>
          <i className="ri-arrow-right-s-line text-gray-600" />
          <span className="text-white font-medium">{agent.machine}</span>
        </div>

        <AgentHeader
          name={agent.name}
          machine={agent.machine}
          status={agent.status}
          version={agent.version}
          ipAddress={agent.ipAddress}
          department={agent.department}
        />

        <DateFilter onChange={() => {}} />

        <AgentStatCards
          firstLogin={agent.firstLogin}
          lastActivity={agent.lastActivity}
          stillActive={agent.stillActive}
          logins={agent.logins}
          logouts={agent.logouts}
          systemOn={agent.systemOn}
          activeWorked={agent.activeWorked}
          screenshotsEnabled={agent.screenshotsEnabled}
          videosEnabled={agent.videosEnabled}
        />

        <QuickStats
          totalActiveTime={agent.totalActiveTime}
          appsUsed={agent.appsUsed}
          sitesVisited={agent.sitesVisited}
          screenshotsCount={agent.screenshotsCount}
          alertsCount={agent.alertsCount}
          sessionsCount={agent.sessionsCount}
        />

        <CaptureControls
          screenshotsEnabled={agent.screenshotsEnabled}
          videosEnabled={agent.videosEnabled}
          onUpdate={updateCaptureSettings}
        />

        <TimelineChart data={agent.timeline} />

        <BottomTabs active={activeTab} onChange={setActiveTab} counts={counts} />

        {activeTab === 'applications' && <TimePerApp apps={agent.appsTime} />}

        {activeTab === 'browser' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            {browserRows.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">No browser activity in the last 24 hours.</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-dark-700">
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Page Title</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Duration</th>
                    <th className="text-left text-xs text-gray-500 font-medium px-4 py-3 uppercase">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {browserRows.slice(-30).reverse().map((r, i) => (
                    <tr key={i} className="border-b border-dark-700/50">
                      <td className="px-4 py-2 text-xs text-gray-300 truncate max-w-md">{r.url ?? '—'}</td>
                      <td className="px-4 py-2 text-xs text-gray-400">{r.duration ?? 0}s</td>
                      <td className="px-4 py-2 text-xs text-gray-500">{formatTime(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {activeTab === 'screenshots' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
            {screenshotRows.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">No screenshots captured yet.</div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {screenshotRows.slice(-20).reverse().map((r, i) => {
                  const path = r.screenshot_url;
                  const url = path ? signedScreenshots[path] : null;
                  return (
                    <div key={i} className="bg-dark-900 border border-dark-700 rounded-lg overflow-hidden">
                      <div className="aspect-video bg-dark-900">
                        {url ? (
                          <img src={url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-600">
                            <i className="ri-image-line text-2xl" />
                          </div>
                        )}
                      </div>
                      <div className="p-2">
                        <p className="text-[10px] text-gray-500">{formatTime(r.created_at)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'alerts' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
            {alerts.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">No alerts for this agent.</div>
            ) : (
              <div className="divide-y divide-dark-700/50">
                {alerts.map((a) => (
                  <div key={a.id} className="p-4 flex items-start gap-3">
                    <span className={`w-2 h-2 mt-1.5 rounded-full flex-shrink-0 ${
                      a.alert_type === 'error' ? 'bg-red-500' : a.alert_type === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white">{a.message}</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">{formatRelative(a.created_at)}{a.ai_resolved ? ' · resolved' : ''}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'timeline' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
            <div className="space-y-1 max-h-96 overflow-y-auto text-xs font-mono">
              {activity.slice(-200).reverse().map((r, i) => (
                <div key={i} className="flex items-start gap-2 py-0.5">
                  <span className="text-gray-500 w-14 flex-shrink-0">{formatTime(r.created_at)}</span>
                  <span className={`w-16 flex-shrink-0 ${
                    r.activity_type === 'idle' ? 'text-amber-400' :
                    r.activity_type === 'screenshot' ? 'text-cyan-400' :
                    r.activity_type === 'browser' ? 'text-emerald-400' : 'text-gray-300'
                  }`}>{r.activity_type}</span>
                  <span className="text-gray-400 truncate">{r.application_name ?? r.url ?? '—'}</span>
                </div>
              ))}
              {activity.length === 0 && <div className="p-4 text-center text-gray-500">No activity yet.</div>}
            </div>
          </div>
        )}

        {activeTab === 'videos' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-8 text-center">
            <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
              <i className="ri-video-line text-3xl" />
            </span>
            <p className="text-sm text-gray-500">Video recording is not yet enabled for this agent.</p>
          </div>
        )}

        {activeTab === 'system' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-8 text-center">
            <p className="text-sm text-gray-500">System health charts open in the dedicated System Health page.</p>
          </div>
        )}

        {activeTab === 'capture' && (
          <CaptureControls
            screenshotsEnabled={agent.screenshotsEnabled}
            videosEnabled={agent.videosEnabled}
            onUpdate={updateCaptureSettings}
          />
        )}

        {activeTab === 'ai' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-8 text-center">
            <span className="w-12 h-12 flex items-center justify-center mx-auto mb-3 text-gray-600">
              <i className="ri-bard-line text-3xl" />
            </span>
            <p className="text-sm text-gray-500">AI chat will appear here.</p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
