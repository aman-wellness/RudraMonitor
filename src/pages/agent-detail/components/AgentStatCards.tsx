interface Props {
  firstLogin: string;
  lastActivity: string;
  stillActive: boolean;
  logins: number;
  logouts: number;
  systemOn: string;
  activeWorked: string;
  idleTime: string;
  screenshotsEnabled: boolean;
  videosEnabled: boolean;
}

export default function AgentStatCards({
  firstLogin,
  lastActivity,
  stillActive,
  logins,
  logouts,
  systemOn,
  activeWorked,
  idleTime,
  screenshotsEnabled,
  videosEnabled,
}: Props) {
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-3 md:p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-login-box-line" /></span>
            First Login
          </p>
          <p className="text-sm font-bold text-white">{firstLogin.split(',')[1]?.trim() || firstLogin}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">earliest sign-in</p>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-3 md:p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-time-line" /></span>
            Last Activity
          </p>
          <p className="text-sm font-bold text-white">{lastActivity.split(',')[1]?.trim() || lastActivity}</p>
          <p className={`text-[10px] mt-0.5 ${stillActive ? 'text-emerald-400' : 'text-gray-500'}`}>
            {stillActive ? 'still active' : 'offline'}
          </p>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-3 md:p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-login-circle-line" /></span>
            Logins
          </p>
          <p className="text-2xl font-poppins font-bold text-white">{logins}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">login: {logins} unlock: 0 wake: 0</p>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-3 md:p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-logout-circle-line" /></span>
            Logouts
          </p>
          <p className="text-2xl font-poppins font-bold text-white">{logouts}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">logout: {logouts} lock: 0 sleep: 0</p>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-3 md:p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-computer-line" /></span>
            System On
          </p>
          <p className="text-sm font-bold text-white">{systemOn}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">approximate</p>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-3 md:p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-flashlight-line" /></span>
            Active / Worked
          </p>
          <p className="text-sm font-bold text-white">{activeWorked}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">approx — first activity → last activity</p>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-3 md:p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-camera-line" /></span>
            Capture Controls
          </p>
          <div className="space-y-1">
            <span className={`text-[10px] flex items-center gap-1 ${screenshotsEnabled ? 'text-emerald-400' : 'text-gray-500'}`}>
              <span className="w-3 h-3 flex items-center justify-center"><i className={screenshotsEnabled ? 'ri-checkbox-circle-fill' : 'ri-close-circle-fill'} /></span>
              Screenshots
            </span>
            <span className={`text-[10px] flex items-center gap-1 ${videosEnabled ? 'text-emerald-400' : 'text-gray-500'}`}>
              <span className="w-3 h-3 flex items-center justify-center"><i className={videosEnabled ? 'ri-checkbox-circle-fill' : 'ri-close-circle-fill'} /></span>
              Videos
            </span>
          </div>
        </div>

        <div className="bg-dark-800 border border-dark-700 rounded-xl p-3 md:p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-timer-line" /></span>
            Idle
          </p>
          <p className="text-sm font-bold text-white">{idleTime}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">sum of idle gaps in window</p>
        </div>
      </div>

      {logins === 0 && logouts === 0 && (
        <div className="bg-dark-800/50 border border-dark-700/50 rounded-lg p-3 flex items-start gap-2">
          <span className="w-4 h-4 flex items-center justify-center text-blue-400 mt-0.5 flex-shrink-0">
            <i className="ri-information-line" />
          </span>
          <p className="text-xs text-gray-500">
            <span className="text-white font-medium">No login/logout events recorded in this window.</span> This agent may be running an older agent version that doesn&apos;t emit system events, or the agent hasn&apos;t been restarted/locked/unlocked during the selected period. System-on time above is approximated from first—last activity span.
          </p>
        </div>
      )}
    </>
  );
}