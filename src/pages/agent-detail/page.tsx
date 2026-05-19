import { useParams } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
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
import { useAgentDetail, type DateRange } from '@/lib/useAgentDetail';
import { useSignedScreenshotUrls, useSignedVideoUrls } from '@/lib/dataHooks';
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
  const [range, setRange] = useState<DateRange>('today');
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const { agent, activity, alerts, loading, notFound, refresh } = useAgentDetail(agentId, range);

  // Live refresh every 30s so SYSTEM ON / IDLE / ACTIVE update without a manual reload.
  useEffect(() => {
    const t = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const updateCaptureSettings = async (p: {
    screenshots: boolean;
    videos: boolean;
    dlp?: boolean;
    screenshotIntervalSecs: number;
    videoIntervalSecs: number;
  }) => {
    if (!agentId) return;
    const patch: Record<string, boolean | number> = {
      screenshots_enabled: p.screenshots,
      videos_enabled: p.videos,
      screenshot_interval_secs: p.screenshotIntervalSecs,
      video_interval_secs: p.videoIntervalSecs,
    };
    if (p.dlp !== undefined) patch.dlp_enabled = p.dlp;
    const { error } = await supabase.from('agents').update(patch).eq('id', agentId);
    if (error) throw error;
    await refresh();
  };

  // Plan-level DLP add-on price (null = DLP not available on this plan).
  const [dlpAddonPriceInr, setDlpAddonPriceInr] = useState<number | null>(null);
  useEffect(() => {
    if (!agent?.orgId) return;
    (async () => {
      const { data: lic } = await supabase
        .from('licenses')
        .select('plans(dlp_addon_price_inr)')
        .eq('organization_id', agent.orgId)
        .eq('status', 'active')
        .order('issued_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const price = (lic?.plans as { dlp_addon_price_inr?: number } | null)?.dlp_addon_price_inr;
      setDlpAddonPriceInr(typeof price === 'number' ? price : null);
    })();
  }, [agent?.orgId]);

  const screenshotPaths = useMemo(
    () => activity.filter((a) => a.activity_type === 'screenshot').map((a) => a.screenshot_url).filter((p): p is string => !!p),
    [activity],
  );
  const signedScreenshots = useSignedScreenshotUrls(screenshotPaths);

  const videoPaths = useMemo(
    () => activity.filter((a) => a.activity_type === 'video').map((a) => a.video_url).filter((p): p is string => !!p),
    [activity],
  );
  const signedVideos = useSignedVideoUrls(videoPaths);
  const videoRows = useMemo(() => activity.filter((a) => a.activity_type === 'video'), [activity]);
  const [videoIdx, setVideoIdx] = useState<number | null>(null);

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
          agentId={agent.id}
          orgId={agent.orgId}
          name={agent.name}
          machine={agent.machine}
          status={agent.status}
          version={agent.version}
          ipAddress={agent.ipAddress}
          department={agent.department}
          onDepartmentChange={() => { void refresh(); }}
        />

        <DateFilter
          onChange={(preset) => {
            // Custom range arrives as "custom:<fromISO>|<toISO>" — pass straight
            // through; useAgentDetail decodes it.
            if (preset.startsWith('custom:')) {
              setRange(preset as DateRange);
              return;
            }
            const map: Record<string, DateRange> = {
              'Today': 'today', 'Yesterday': 'yesterday',
              '7 days': '7d', '30 days': '30d', 'All time': 'all',
            };
            setRange(map[preset] ?? 'today');
          }}
        />

        <AgentStatCards
          firstLogin={agent.firstLogin}
          lastActivity={agent.lastActivity}
          stillActive={agent.stillActive}
          logins={agent.logins}
          logouts={agent.logouts}
          systemOn={agent.systemOn}
          activeWorked={agent.activeWorked}
          idleTime={agent.idleTime ?? '0h 00m'}
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
          dlpEnabled={agent.dlpEnabled}
          screenshotIntervalSecs={agent.screenshotIntervalSecs}
          videoIntervalSecs={agent.videoIntervalSecs}
          dlpAddonPriceInr={dlpAddonPriceInr}
          onUpdate={updateCaptureSettings}
        />

        <TimelineChart data={agent.timeline} />

        <BottomTabs active={activeTab} onChange={setActiveTab} counts={counts} />

        {activeTab === 'applications' && <TimePerApp apps={agent.appsTime} />}

        {activeTab === 'browser' && (() => {
          const visible = browserRows.slice(-30).reverse();
          const noUrlCount = visible.filter((r) => !((r.url ?? '').trim().startsWith('http'))).length;
          const showAutomationHint = visible.length > 0 && noUrlCount / visible.length > 0.4;
          return (
            <div className="space-y-3">
              {showAutomationHint && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 text-xs text-amber-300 flex items-start gap-2">
                  <i className="ri-information-line text-base mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-200">Many sessions are missing URLs</p>
                    {(() => {
                      const os = (agent.os ?? '').toLowerCase();
                      if (os.includes('mac')) {
                        return (
                          <p className="text-amber-300/80 mt-0.5">
                            On macOS, grant Automation permission so the agent can read browser tab URLs.
                            System Settings → Privacy &amp; Security → Automation → Rudrans Agent → enable Chrome / Brave / Safari.
                          </p>
                        );
                      }
                      if (os.includes('win')) {
                        return (
                          <p className="text-amber-300/80 mt-0.5">
                            On Windows, the agent reads URLs through the OS UI Automation API. If URLs are still missing,
                            ensure PowerShell + .NET 4.x are available and the browser window is visible (UIA cannot read
                            minimised or background windows). Restart the agent after browser updates.
                          </p>
                        );
                      }
                      if (os.includes('ubuntu') || os.includes('linux')) {
                        return (
                          <p className="text-amber-300/80 mt-0.5">
                            On Linux, browser URL extraction is not yet implemented — only window titles are captured.
                            Install xdotool / wmctrl for richer window metadata.
                          </p>
                        );
                      }
                      return (
                        <p className="text-amber-300/80 mt-0.5">
                          The agent could not extract tab URLs from the browser. Check the agent&apos;s OS-specific
                          permissions and ensure the browser window is on the foreground.
                        </p>
                      );
                    })()}
                  </div>
                </div>
              )}
              <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
                {browserRows.length === 0 ? (
                  <div className="p-8 text-center text-sm text-gray-500">No browser activity in the last 24 hours.</div>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-dark-700 bg-dark-900/40">
                        <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 uppercase tracking-wider">Website</th>
                        <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 uppercase tracking-wider">Page Title</th>
                        <th className="text-left text-xs text-gray-400 font-medium px-4 py-3 uppercase tracking-wider">Browser</th>
                        <th className="text-right text-xs text-gray-400 font-medium px-4 py-3 uppercase tracking-wider">Duration</th>
                        <th className="text-right text-xs text-gray-400 font-medium px-4 py-3 uppercase tracking-wider">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r, i) => {
                        const url = (r.url ?? '').trim();
                        const title = (r.page_title ?? '').trim();
                        const app = (r.application_name ?? '').trim();
                        let host = '';
                        try { if (url) host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
                        const isUrl = url.startsWith('http');
                        return (
                          <tr key={i} className="border-b border-dark-700/40 hover:bg-dark-700/20">
                            <td className="px-4 py-2.5 max-w-xs">
                              {isUrl ? (
                                <a href={url} target="_blank" rel="noreferrer"
                                  className="text-cyan-400 hover:text-cyan-300 hover:underline text-xs truncate block"
                                  title={url}>
                                  {host || url.slice(0, 40)}
                                </a>
                              ) : (
                                <span className="text-gray-500 text-xs italic" title="URL not captured">— no URL —</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 max-w-md">
                              <span className="text-gray-200 text-xs truncate block" title={title || undefined}>
                                {title || <span className="text-gray-600">—</span>}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-gray-500">{app || '—'}</td>
                            <td className="px-4 py-2.5 text-right text-xs text-gray-300 font-medium">{r.duration ?? 0}s</td>
                            <td className="px-4 py-2.5 text-right text-xs text-gray-500 whitespace-nowrap">{formatTime(r.created_at)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          );
        })()}

        {activeTab === 'screenshots' && (() => {
          const recent = screenshotRows.slice(-40).reverse();
          return (
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
              {recent.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-300">No screenshots captured yet.</div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {recent.map((r, i) => {
                    const path = r.screenshot_url;
                    const url = path ? signedScreenshots[path] : null;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => url && setLightboxIdx(i)}
                        className="group bg-dark-900 border border-dark-700 hover:border-cyan-500/50 rounded-lg overflow-hidden text-left transition-all"
                      >
                        <div className="relative aspect-video bg-dark-900">
                          {url ? (
                            <>
                              <img src={url} alt="" className="w-full h-full object-cover" />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                                <span className="opacity-0 group-hover:opacity-100 transition-opacity w-10 h-10 flex items-center justify-center rounded-full bg-white/90">
                                  <i className="ri-zoom-in-line text-dark-900 text-base" />
                                </span>
                              </div>
                            </>
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-500">
                              <i className="ri-image-line text-2xl" />
                            </div>
                          )}
                        </div>
                        <div className="px-2.5 py-2 flex items-center justify-between">
                          <p className="text-[11px] text-gray-300">{formatTime(r.created_at)}</p>
                          <span className="text-[10px] text-gray-500">#{recent.length - i}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {lightboxIdx !== null && recent[lightboxIdx] && (() => {
                const cur = recent[lightboxIdx];
                const url = cur.screenshot_url ? signedScreenshots[cur.screenshot_url] : null;
                const prev = () => setLightboxIdx((idx) => idx === null ? null : Math.min(recent.length - 1, idx + 1));
                const next = () => setLightboxIdx((idx) => idx === null ? null : Math.max(0, idx - 1));
                const close = () => setLightboxIdx(null);
                return (
                  <div
                    className="fixed inset-0 z-[100] bg-black/90 flex flex-col"
                    onClick={close}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') close();
                      else if (e.key === 'ArrowLeft') prev();
                      else if (e.key === 'ArrowRight') next();
                    }}
                    tabIndex={-1}
                    ref={(el) => el?.focus()}
                  >
                    <div className="flex items-center justify-between px-5 py-3 bg-dark-900/80 backdrop-blur" onClick={(e) => e.stopPropagation()}>
                      <div>
                        <p className="text-sm text-white font-medium">
                          {new Date(cur.created_at).toLocaleString([], { weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </p>
                        <p className="text-[11px] text-gray-300">Screenshot {lightboxIdx + 1} of {recent.length}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer" download
                            className="px-3 py-1.5 text-xs rounded-lg bg-dark-700 hover:bg-dark-600 text-white">
                            <i className="ri-download-line mr-1" /> Download
                          </a>
                        )}
                        <button onClick={close} className="w-8 h-8 flex items-center justify-center rounded-lg bg-dark-700 hover:bg-dark-600 text-white">
                          <i className="ri-close-line text-lg" />
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 flex items-center justify-center p-4 relative" onClick={(e) => e.stopPropagation()}>
                      {url ? (
                        <img src={url} alt="" className="max-w-full max-h-full object-contain rounded shadow-2xl" />
                      ) : (
                        <div className="text-gray-300 text-sm">Loading…</div>
                      )}

                      {lightboxIdx < recent.length - 1 && (
                        <button onClick={prev}
                          className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-dark-800/80 hover:bg-dark-700 text-white shadow-lg">
                          <i className="ri-arrow-left-s-line text-2xl" />
                        </button>
                      )}
                      {lightboxIdx > 0 && (
                        <button onClick={next}
                          className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-dark-800/80 hover:bg-dark-700 text-white shadow-lg">
                          <i className="ri-arrow-right-s-line text-2xl" />
                        </button>
                      )}
                    </div>

                    <div className="px-5 py-3 bg-dark-900/80 backdrop-blur text-center text-[11px] text-gray-400" onClick={(e) => e.stopPropagation()}>
                      <kbd className="px-1.5 py-0.5 rounded bg-dark-700 text-gray-200">←</kbd> previous
                      <span className="mx-2">·</span>
                      <kbd className="px-1.5 py-0.5 rounded bg-dark-700 text-gray-200">→</kbd> next
                      <span className="mx-2">·</span>
                      <kbd className="px-1.5 py-0.5 rounded bg-dark-700 text-gray-200">Esc</kbd> close
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

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

        {activeTab === 'timeline' && (() => {
          const TYPE_META: Record<string, { label: string; icon: string; color: string; bg: string }> = {
            app:            { label: 'App',         icon: 'ri-window-line',     color: 'text-blue-300',    bg: 'bg-blue-500/20 border-blue-500/30' },
            browser:        { label: 'Browser',     icon: 'ri-global-line',     color: 'text-emerald-300', bg: 'bg-emerald-500/20 border-emerald-500/30' },
            idle:           { label: 'Idle',        icon: 'ri-pause-circle-line', color: 'text-amber-300', bg: 'bg-amber-500/20 border-amber-500/30' },
            screenshot:     { label: 'Screenshot',  icon: 'ri-camera-line',     color: 'text-cyan-300',    bg: 'bg-cyan-500/20 border-cyan-500/30' },
            session_start:  { label: 'Session',     icon: 'ri-login-circle-line', color: 'text-violet-300', bg: 'bg-violet-500/20 border-violet-500/30' },
            alert:          { label: 'Alert',       icon: 'ri-alarm-warning-line', color: 'text-red-300', bg: 'bg-red-500/20 border-red-500/30' },
          };
          const groups: Record<string, typeof activity> = {};
          for (const r of activity.slice(-300).reverse()) {
            const day = new Date(r.created_at).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
            if (!groups[day]) groups[day] = [];
            groups[day].push(r);
          }
          if (activity.length === 0) {
            return (
              <div className="bg-dark-800 border border-dark-700 rounded-xl p-12 text-center">
                <i className="ri-time-line text-3xl text-gray-500 block mb-2" />
                <p className="text-sm text-gray-300">No activity recorded yet.</p>
                <p className="text-xs text-gray-500 mt-1">Activity will appear here as the agent reports back.</p>
              </div>
            );
          }
          return (
            <div className="bg-dark-800 border border-dark-700 rounded-xl overflow-hidden">
              <div className="max-h-[600px] overflow-y-auto">
                {Object.entries(groups).map(([day, rows]) => (
                  <div key={day}>
                    <div className="sticky top-0 z-10 bg-dark-900/95 backdrop-blur px-4 py-2 border-b border-dark-700 flex items-center justify-between">
                      <span className="text-xs font-semibold text-white uppercase tracking-wider">{day}</span>
                      <span className="text-[11px] text-gray-400">{rows.length} events</span>
                    </div>
                    <ul className="divide-y divide-dark-700/40">
                      {rows.map((r, i) => {
                        const meta = TYPE_META[r.activity_type] ?? { label: r.activity_type, icon: 'ri-circle-line', color: 'text-gray-300', bg: 'bg-dark-700 border-dark-600' };
                        const url = (r.url ?? '').trim();
                        const title = (r.page_title ?? '').trim();
                        const app = (r.application_name ?? '').trim();
                        let host = '';
                        try { if (url.startsWith('http')) host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
                        const primary =
                          r.activity_type === 'browser' ? (host || app || 'Browser') :
                          r.activity_type === 'idle' ? `Idle (${r.duration ?? 0}s)` :
                          r.activity_type === 'screenshot' ? 'Screenshot captured' :
                          r.activity_type === 'session_start' ? 'Session started' :
                          (app || '—');
                        const secondary =
                          r.activity_type === 'browser' ? (title || (url && !url.startsWith('http') ? url : '')) :
                          (app && primary !== app ? app : '');
                        return (
                          <li key={i} className="flex items-start gap-3 px-4 py-3 hover:bg-dark-700/30">
                            <span className={`w-9 h-9 flex-shrink-0 rounded-lg border flex items-center justify-center ${meta.bg}`}>
                              <i className={`${meta.icon} text-base ${meta.color}`} />
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline justify-between gap-3">
                                <span className="text-sm font-medium text-white truncate">{primary}</span>
                                <span className="text-[11px] text-gray-400 whitespace-nowrap">{formatTime(r.created_at)}</span>
                              </div>
                              {secondary && (
                                <p className="text-xs text-gray-300 mt-0.5 truncate" title={secondary}>{secondary}</p>
                              )}
                              <div className="flex items-center gap-3 mt-1.5 text-[11px] text-gray-400">
                                <span className={`px-1.5 py-0.5 rounded ${meta.bg} ${meta.color}`}>{meta.label}</span>
                                {(r.duration ?? 0) > 0 && r.activity_type !== 'idle' && (
                                  <span><i className="ri-time-line mr-0.5" />{r.duration}s</span>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {activeTab === 'videos' && (() => {
          const recent = videoRows.slice(-40).reverse();
          return (
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-4">
              {recent.length === 0 ? (
                <div className="p-8 text-center">
                  <i className="ri-video-line text-3xl text-gray-500 block mb-2" />
                  <p className="text-sm text-gray-300">No video clips yet.</p>
                  <p className="text-xs text-gray-400 mt-1">
                    Enable Video Recording in Capture Controls and ensure ffmpeg is installed.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {recent.map((r, i) => {
                    const url = r.video_url ? signedVideos[r.video_url] : null;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => url && setVideoIdx(i)}
                        className="group bg-dark-900 border border-dark-700 hover:border-cyan-500/50 rounded-lg overflow-hidden text-left transition-all"
                      >
                        <div className="relative aspect-video bg-black">
                          {url ? (
                            <video src={url} className="w-full h-full object-cover" muted preload="metadata" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-500">
                              <i className="ri-video-line text-2xl" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                            <span className="w-12 h-12 flex items-center justify-center rounded-full bg-white/90">
                              <i className="ri-play-fill text-dark-900 text-xl" />
                            </span>
                          </div>
                          <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-white font-medium">
                            {r.duration ?? 10}s
                          </div>
                        </div>
                        <div className="px-2.5 py-2 flex items-center justify-between">
                          <p className="text-[11px] text-gray-300">{formatTime(r.created_at)}</p>
                          <span className="text-[10px] text-gray-500">#{recent.length - i}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {videoIdx !== null && recent[videoIdx] && (() => {
                const cur = recent[videoIdx];
                const url = cur.video_url ? signedVideos[cur.video_url] : null;
                const prev = () => setVideoIdx((idx) => idx === null ? null : Math.min(recent.length - 1, idx + 1));
                const next = () => setVideoIdx((idx) => idx === null ? null : Math.max(0, idx - 1));
                const close = () => setVideoIdx(null);
                return (
                  <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col" onClick={close}>
                    <div className="flex items-center justify-between px-5 py-3 bg-dark-900/80 backdrop-blur" onClick={(e) => e.stopPropagation()}>
                      <div>
                        <p className="text-sm text-white font-medium">
                          {new Date(cur.created_at).toLocaleString([], { weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </p>
                        <p className="text-[11px] text-gray-300">Clip {videoIdx + 1} of {recent.length} · {cur.duration ?? 10}s</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer" download
                            className="px-3 py-1.5 text-xs rounded-lg bg-dark-700 hover:bg-dark-600 text-white">
                            <i className="ri-download-line mr-1" /> Download
                          </a>
                        )}
                        <button onClick={close} className="w-8 h-8 flex items-center justify-center rounded-lg bg-dark-700 hover:bg-dark-600 text-white">
                          <i className="ri-close-line text-lg" />
                        </button>
                      </div>
                    </div>
                    <div className="flex-1 flex items-center justify-center p-4 relative" onClick={(e) => e.stopPropagation()}>
                      {url ? (
                        <video src={url} controls autoPlay className="max-w-full max-h-full rounded shadow-2xl" />
                      ) : (
                        <div className="text-gray-300 text-sm">Loading…</div>
                      )}
                      {videoIdx < recent.length - 1 && (
                        <button onClick={prev}
                          className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-dark-800/80 hover:bg-dark-700 text-white shadow-lg">
                          <i className="ri-arrow-left-s-line text-2xl" />
                        </button>
                      )}
                      {videoIdx > 0 && (
                        <button onClick={next}
                          className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-dark-800/80 hover:bg-dark-700 text-white shadow-lg">
                          <i className="ri-arrow-right-s-line text-2xl" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {activeTab === 'system' && (
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-8 text-center">
            <p className="text-sm text-gray-500">System health charts open in the dedicated System Health page.</p>
          </div>
        )}

        {activeTab === 'capture' && (
          <CaptureControls
            screenshotsEnabled={agent.screenshotsEnabled}
            videosEnabled={agent.videosEnabled}
            dlpEnabled={agent.dlpEnabled}
            screenshotIntervalSecs={agent.screenshotIntervalSecs}
            videoIntervalSecs={agent.videoIntervalSecs}
            dlpAddonPriceInr={dlpAddonPriceInr}
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
