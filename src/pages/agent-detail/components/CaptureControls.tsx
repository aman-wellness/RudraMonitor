import { useEffect, useState } from 'react';

interface Props {
  screenshotsEnabled: boolean;
  videosEnabled: boolean;
  dlpEnabled?: boolean;
  removableDisksBlocked?: boolean;
  wallpaperEnforced?: boolean;
  trackingScheduleOverride?: boolean;
  screenshotIntervalSecs: number;
  videoIntervalSecs: number;
  // undefined = plan check still loading (don't show "not available" yet);
  // null     = plan really doesn't include DLP;
  // number   = DLP available at this monthly price per agent.
  dlpAddonPriceInr?: number | null;
  // True when the org is on free trial — DLP is unlocked at no cost in that case.
  isTrial?: boolean;
  onUpdate: (patch: {
    screenshots: boolean;
    videos: boolean;
    dlp?: boolean;
    removableDisksBlocked?: boolean;
    wallpaperEnforced?: boolean;
    trackingScheduleOverride?: boolean;
    screenshotIntervalSecs: number;
    videoIntervalSecs: number;
  }) => Promise<void> | void;
}

// DB check constraint: screenshot_interval_secs ∈ [30, 3600].
const SS_PRESETS = [
  { secs: 60, label: '1 min' },
  { secs: 120, label: '2 min' },
  { secs: 300, label: '5 min' },
  { secs: 600, label: '10 min' },
  { secs: 900, label: '15 min' },
  { secs: 1800, label: '30 min' },
  { secs: 3600, label: '1 hr' },
];

// DB check constraint: video_interval_secs ∈ [60, 14400].
const VID_PRESETS = [
  { secs: 120, label: '2 min' },
  { secs: 300, label: '5 min' },
  { secs: 900, label: '15 min' },
  { secs: 1800, label: '30 min' },
  { secs: 3600, label: '1 hr' },
  { secs: 7200, label: '2 hr' },
  { secs: 14400, label: '4 hr' },
];

export default function CaptureControls({
  screenshotsEnabled, videosEnabled, dlpEnabled = false,
  removableDisksBlocked = true, wallpaperEnforced = true,
  trackingScheduleOverride = false,
  screenshotIntervalSecs, videoIntervalSecs,
  dlpAddonPriceInr, isTrial = false, onUpdate,
}: Props) {
  const [ss, setSs] = useState(screenshotsEnabled);
  const [vid, setVid] = useState(videosEnabled);
  const [dlp, setDlp] = useState(dlpEnabled);
  const [usbBlock, setUsbBlock] = useState(removableDisksBlocked);
  const [wallpaper, setWallpaper] = useState(wallpaperEnforced);
  const [scheduleOverride, setScheduleOverride] = useState(trackingScheduleOverride);
  const [ssEvery, setSsEvery] = useState(screenshotIntervalSecs);
  const [vidEvery, setVidEvery] = useState(videoIntervalSecs);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The parent re-fetches the agent row every time the agent heartbeats
  // (via realtime UPDATE subscription on `agents`). That heartbeat fires
  // every 30 sec and updates only `last_active`, but it re-runs buildDetail
  // and produces a brand-new agent object — props change identity every
  // 30 sec.
  //
  // Old behaviour: each effect blindly mirrored the prop into local state.
  // If the user toggled OFF but hadn't clicked Save yet, the next heartbeat
  // snapped the toggle visually back to ON before they could save — and
  // even after Save, the form would re-flash from a stale heartbeat that
  // raced with the save's own refresh.
  //
  // New behaviour: a `touched` flag latches as soon as the user clicks any
  // toggle. While touched, the prop-sync effects are skipped — local state
  // is the source of truth. handleSave clears `touched` AFTER the save
  // completes and the parent refresh has run, so the next heartbeat naturally
  // resyncs from the now-correct DB row.
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (touched) return;
    setSs(screenshotsEnabled);
    setVid(videosEnabled);
    setDlp(dlpEnabled);
    setUsbBlock(removableDisksBlocked);
    setWallpaper(wallpaperEnforced);
    setScheduleOverride(trackingScheduleOverride);
    setSsEvery(screenshotIntervalSecs);
    setVidEvery(videoIntervalSecs);
  }, [
    touched,
    screenshotsEnabled,
    videosEnabled,
    dlpEnabled,
    removableDisksBlocked,
    wallpaperEnforced,
    trackingScheduleOverride,
    screenshotIntervalSecs,
    videoIntervalSecs,
  ]);

  const markTouched = () => setTouched(true);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await onUpdate({
        screenshots: ss,
        videos: vid,
        dlp,
        removableDisksBlocked: usbBlock,
        wallpaperEnforced: wallpaper,
        trackingScheduleOverride: scheduleOverride,
        screenshotIntervalSecs: ssEvery,
        videoIntervalSecs: vidEvery,
      });
      setSaved(true);
      // Clear the touched flag AFTER the parent's refresh has completed
      // (await onUpdate finished both the edge-function call and the
      // refresh). With touched=false the next prop change resyncs the
      // form to the DB.
      setTouched(false);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges =
    ss !== screenshotsEnabled || vid !== videosEnabled || dlp !== dlpEnabled ||
    usbBlock !== removableDisksBlocked || wallpaper !== wallpaperEnforced ||
    scheduleOverride !== trackingScheduleOverride ||
    ssEvery !== screenshotIntervalSecs || vidEvery !== videoIntervalSecs;

  // Three states: plan check is still loading, DLP is unavailable, or DLP is
  // available. During trial we unlock DLP regardless of plan price — matches
  // the "all features unlocked" trial messaging on the Subscription page.
  const dlpLoading = dlpAddonPriceInr === undefined;
  const dlpAvailable = isTrial || (typeof dlpAddonPriceInr === 'number');

  const selectCls = 'bg-dark-800 border border-dark-700 rounded-md text-[11px] text-white px-2 py-1 focus:outline-none focus:border-emerald-500';

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-5 h-5 flex items-center justify-center">
          <i className="ri-camera-line text-emerald-400 text-sm" />
        </span>
        <h3 className="text-sm font-semibold text-white">Capture Controls</h3>
      </div>
      <p className="text-[11px] text-gray-500 mb-4">Enable or disable screen recording features for this agent. Changes apply on the next agent heartbeat (within ~1 min).</p>

      <div className="space-y-3">
        {/* Screenshot */}
        <div className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
          <div className="flex items-center gap-3">
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${ss ? 'bg-emerald-500/15' : 'bg-dark-700'}`}>
              <i className={`ri-image-line ${ss ? 'text-emerald-400' : 'text-gray-600'}`} />
            </span>
            <div>
              <p className="text-xs text-white font-medium">Screenshots</p>
              <p className="text-[11px] text-gray-500">Captures on activity / URL change, throttled by interval below</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={SS_PRESETS.some((p) => p.secs === ssEvery) ? ssEvery : 0}
              onChange={(e) => { setSsEvery(Number(e.target.value)); markTouched(); }}
              disabled={!ss}
              className={`${selectCls} ${!ss ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {!SS_PRESETS.some((p) => p.secs === ssEvery) && (
                <option value={0} disabled>{ssEvery}s (custom)</option>
              )}
              {SS_PRESETS.map((p) => (
                <option key={p.secs} value={p.secs}>{p.label}</option>
              ))}
            </select>
            <button
              onClick={() => { setSs(!ss); markTouched(); }}
              className={`w-10 h-5 rounded-full transition-colors relative ${ss ? 'bg-emerald-500' : 'bg-dark-700'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${ss ? 'left-[22px]' : 'left-[2px]'}`} />
            </button>
          </div>
        </div>

        {/* Video */}
        <div className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
          <div className="flex items-center gap-3">
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${vid ? 'bg-emerald-500/15' : 'bg-dark-700'}`}>
              <i className={`ri-video-line ${vid ? 'text-emerald-400' : 'text-gray-600'}`} />
            </span>
            <div>
              <p className="text-xs text-white font-medium">Video Recording</p>
              <p className="text-[11px] text-gray-500">10-sec clip every interval</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={VID_PRESETS.some((p) => p.secs === vidEvery) ? vidEvery : 0}
              onChange={(e) => { setVidEvery(Number(e.target.value)); markTouched(); }}
              disabled={!vid}
              className={`${selectCls} ${!vid ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {!VID_PRESETS.some((p) => p.secs === vidEvery) && (
                <option value={0} disabled>{vidEvery}s (custom)</option>
              )}
              {VID_PRESETS.map((p) => (
                <option key={p.secs} value={p.secs}>{p.label}</option>
              ))}
            </select>
            <button
              onClick={() => { setVid(!vid); markTouched(); }}
              className={`w-10 h-5 rounded-full transition-colors relative ${vid ? 'bg-emerald-500' : 'bg-dark-700'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${vid ? 'left-[22px]' : 'left-[2px]'}`} />
            </button>
          </div>
        </div>

        {/* DLP */}
        <div className={`flex items-center justify-between bg-dark-900 rounded-lg border p-3 ${dlpAvailable && !dlpLoading ? 'border-dark-700' : 'border-dark-700/50 opacity-60'}`}>
          <div className="flex items-center gap-3">
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${dlp && dlpAvailable ? 'bg-cyan-500/15' : 'bg-dark-700'}`}>
              <i className={`ri-shield-keyhole-line ${dlp && dlpAvailable ? 'text-cyan-400' : 'text-gray-600'}`} />
            </span>
            <div>
              <p className="text-xs text-white font-medium flex items-center gap-2">
                Data Loss Prevention (DLP)
                {!dlpLoading && isTrial && (
                  <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    Trial — free
                  </span>
                )}
                {!dlpLoading && !isTrial && typeof dlpAddonPriceInr === 'number' && (
                  <span className="px-1.5 py-0.5 text-[9px] uppercase rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                    +₹{dlpAddonPriceInr}/mo
                  </span>
                )}
              </p>
              <p className="text-[11px] text-gray-500">
                {dlpLoading
                  ? 'Checking plan…'
                  : dlpAvailable
                    ? 'USB transfer + email-attachment monitoring with AI alerts'
                    : 'DLP not available on your current plan'}
              </p>
            </div>
          </div>
          <button
            onClick={() => dlpAvailable && !dlpLoading && setDlp(!dlp)}
            disabled={!dlpAvailable || dlpLoading}
            className={`w-10 h-5 rounded-full transition-colors relative ${dlp && dlpAvailable && !dlpLoading ? 'bg-cyan-500' : 'bg-dark-700'} disabled:cursor-not-allowed`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${dlp && dlpAvailable && !dlpLoading ? 'left-[22px]' : 'left-[2px]'}`} />
          </button>
        </div>

        {/* Removable disk block */}
        <div className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
          <div className="flex items-center gap-3">
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${usbBlock ? 'bg-rose-500/15' : 'bg-dark-700'}`}>
              <i className={`ri-usb-line ${usbBlock ? 'text-rose-400' : 'text-gray-600'}`} />
            </span>
            <div>
              <p className="text-xs text-white font-medium">Block removable disks</p>
              <p className="text-[11px] text-gray-500">
                {usbBlock
                  ? 'USB sticks, external drives & SD cards are auto-ejected on connect'
                  : 'This agent can read/write removable storage (allowlisted)'}
              </p>
            </div>
          </div>
          <button
            onClick={() => { setUsbBlock(!usbBlock); markTouched(); }}
            className={`w-10 h-5 rounded-full transition-colors relative ${usbBlock ? 'bg-rose-500' : 'bg-dark-700'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${usbBlock ? 'left-[22px]' : 'left-[2px]'}`} />
          </button>
        </div>

        {/* Wallpaper enforcement */}
        <div className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
          <div className="flex items-center gap-3">
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${wallpaper ? 'bg-indigo-500/15' : 'bg-dark-700'}`}>
              <i className={`ri-image-2-line ${wallpaper ? 'text-indigo-400' : 'text-gray-600'}`} />
            </span>
            <div>
              <p className="text-xs text-white font-medium">Apply org wallpaper</p>
              <p className="text-[11px] text-gray-500">
                {wallpaper
                  ? 'Desktop wallpaper is pushed from org Settings → Branding'
                  : 'This agent keeps its current wallpaper (exempt from org push)'}
              </p>
            </div>
          </div>
          <button
            onClick={() => { setWallpaper(!wallpaper); markTouched(); }}
            className={`w-10 h-5 rounded-full transition-colors relative ${wallpaper ? 'bg-indigo-500' : 'bg-dark-700'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${wallpaper ? 'left-[22px]' : 'left-[2px]'}`} />
          </button>
        </div>

        {/* Tracking schedule override — exempts this agent from the org-wide
            working-hours policy so it tracks 24/7. Useful for CEO laptops,
            security analysts, after-hours support staff, etc. */}
        <div className="flex items-center justify-between bg-dark-900 rounded-lg border border-dark-700 p-3">
          <div className="flex items-center gap-3">
            <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${scheduleOverride ? 'bg-amber-500/15' : 'bg-dark-700'}`}>
              <i className={`ri-time-line ${scheduleOverride ? 'text-amber-400' : 'text-gray-600'}`} />
            </span>
            <div>
              <p className="text-xs text-white font-medium">Override tracking schedule (24/7)</p>
              <p className="text-[11px] text-gray-500">
                {scheduleOverride
                  ? 'This agent tracks 24/7 — ignores the org working-hours policy'
                  : 'Follows the org-wide schedule from Settings → Org Settings'}
              </p>
            </div>
          </div>
          <button
            onClick={() => { setScheduleOverride(!scheduleOverride); markTouched(); }}
            className={`w-10 h-5 rounded-full transition-colors relative ${scheduleOverride ? 'bg-amber-500' : 'bg-dark-700'}`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${scheduleOverride ? 'left-[22px]' : 'left-[2px]'}`} />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-dark-700">
        {error && <span className="text-xs text-red-400">{error}</span>}
        {saved && (
          <span className="text-xs text-emerald-400 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-check-line text-xs" /></span>
            Saved — agent picks up within 1 min
          </span>
        )}
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
            hasChanges && !saving
              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25'
              : 'bg-dark-700 text-gray-500 cursor-not-allowed border border-dark-700'
          }`}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
