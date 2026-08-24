import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import Breadcrumb from '@/components/Breadcrumb';
import OSCard from './components/OSCard';
import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useAgents } from '@/lib/dataHooks';
import { supabase } from '@/lib/supabase';

const RELEASES_BASE = 'https://api-ems.wellnessextract.com/storage/v1/object/public/releases';
// Builds are produced by .github/workflows/build-agent.yml on every workflow_dispatch / tag push.
// File names embed the git ref (`v0.2.0` for tag pushes, `main` for branch builds).
// We default to the latest tagged release and fetch the actual current version
// from latest.json at runtime so the Setup page never drifts behind a code change.
// Only used if latest.json is unreachable at page-load time. Bump these
// after a big release so the fallback stays fresh; the useEffect below
// overwrites both when the manifest fetch succeeds (which is nearly always).
const BUILD_REF = 'v0.6.17';
const FALLBACK_VERSION = '0.6.17';

const buildOsData = (version: string, ref: string) => [
  {
    os: 'macOS',
    icon: 'ri-apple-line',
    color: 'text-amber-400',
    borderColor: 'border-amber-500/20',
    bgColor: 'bg-amber-500/10',
    minVersion: 'macOS 12+',
    arch: 'Apple Silicon (M1/M2/M3) · Intel',
    downloads: [
      {
        label: 'Apple Silicon (.pkg)',
        filename: `Security-Assistant-macOS-arm64-${ref}.pkg`,
        url: `${RELEASES_BASE}/Security-Assistant-macOS-arm64-${ref}.pkg`,
        size: '~4 MB',
        version,
      },
      {
        label: 'Intel (.pkg)',
        filename: `Security-Assistant-macOS-x64-${ref}.pkg`,
        url: `${RELEASES_BASE}/Security-Assistant-macOS-x64-${ref}.pkg`,
        size: '~4 MB',
        version,
      },
    ],
    steps: [
      'Download the .pkg matching your Mac (Apple Silicon = M1/M2/M3+, Intel = older)',
      'Double-click the .pkg — no Gatekeeper warning (build v0.6.15+ is Apple-notarized). Enter your Mac password when the installer asks.',
      'Grant Screen Recording + Accessibility in System Settings → Privacy & Security (toggle Security Assistant on).',
      'Launch Security Assistant from Applications — enrollment dialog appears.',
      'Paste the License Key below and your agent name. Done — agent runs silently in the background and auto-starts on every reboot.',
    ],
  },
  {
    os: 'Windows',
    icon: 'ri-windows-line',
    color: 'text-blue-400',
    borderColor: 'border-blue-500/20',
    bgColor: 'bg-blue-500/10',
    minVersion: 'Windows 10/11',
    arch: 'x64',
    downloads: [
      {
        label: 'NSIS Installer (.exe)',
        filename: `Security-Assistant-Windows-${ref}.exe`,
        url: `${RELEASES_BASE}/Security-Assistant-Windows-${ref}.exe`,
        size: '~73 MB',
        version,
      },
      {
        label: 'MSI Installer (.msi) — MDM / Intune',
        filename: `Security-Assistant-Windows-${ref}.msi`,
        url: `${RELEASES_BASE}/Security-Assistant-Windows-${ref}.msi`,
        size: '~96 MB',
        version,
      },
    ],
    steps: [
      'Personal Windows — download the .exe and double-click. Installs silently to your user profile (no admin prompt).',
      'Corporate / MDM-managed Windows — use the .msi instead. IT admin uploads it to Intune (Apps → Windows → Add → Line-of-business app → upload .msi) or pushes via AppLocker / Group Policy.',
      'If Windows SmartScreen warns "Unknown publisher" → click "More info" → "Run anyway" (until our Azure Trusted Signing cert lands).',
      'Enrollment dialog opens — paste the License Key below and your name.',
      'Agent runs hidden in the tray; auto-updates silently going forward.',
    ],
  },
  {
    os: 'Ubuntu',
    icon: 'ri-ubuntu-line',
    color: 'text-orange-400',
    borderColor: 'border-orange-500/20',
    bgColor: 'bg-orange-500/10',
    minVersion: 'Ubuntu 22.04+',
    arch: 'x64',
    downloads: [
      {
        label: 'Debian Package (.deb)',
        filename: `security-assistant_${ref}_amd64.deb`,
        url: `${RELEASES_BASE}/security-assistant_${ref}_amd64.deb`,
        size: '~5 MB',
        version,
      },
    ],
    steps: [
      'Download the .deb package',
      'Run `sudo dpkg -i security-assistant_*.deb` (or double-click on GNOME)',
      'Launch from app menu — enrollment dialog appears once',
      'Agent runs in the background; relaunches on every login',
    ],
  },
];

export default function SetupPage() {
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentDept, setNewAgentDept] = useState('Unassigned');
  // Live department list for this org. Falls back to the static list below
  // when the org hasn't customised departments yet (fresh signups).
  const [orgDepts, setOrgDepts] = useState<string[] | null>(null);
  useEffect(() => {
    supabase.from('org_departments').select('name').order('name').then(({ data }) => {
      if (!data) return;
      const names = data.map((d) => d.name).filter(Boolean);
      setOrgDepts(names.length > 0 ? names : null);
    });
  }, []);
  const DEPT_FALLBACK = ['Unassigned', 'Development', 'HR', 'Finance', 'Design', 'Sales', 'Support', 'Marketing'];
  const deptOptions = orgDepts ? ['Unassigned', ...orgDepts.filter((n) => n !== 'Unassigned')] : DEPT_FALLBACK;
  const [newAgentOS, setNewAgentOS] = useState('Windows');
  const [creating, setCreating] = useState(false);
  const { organization } = useAuth();
  const { agents, createAgent } = useAgents();

  // Pull the live release version from the same latest.json the desktop
  // agents poll for auto-updates. Bumping the version in tauri.conf.json
  // (+ shipping a new build via CI) is the only step admins need — the
  // Setup page's "Latest Version" label + per-card version chips update
  // automatically on next page load. Fallback pins to BUILD_REF only if
  // latest.json is unreachable (offline / storage outage).
  //
  // (This coupling was intentionally broken during the v0.6.15 hand-
  // notarization window when .pkg artifacts existed OUTSIDE latest.json.
  // Now that CI reliably writes latest.json for every tag, we're back on
  // the auto-track — see git history if you're wondering why the
  // useEffect looks slightly over-commented.)
  const [agentVersion, setAgentVersion] = useState(FALLBACK_VERSION);
  useEffect(() => {
    let alive = true;
    fetch(`${RELEASES_BASE}/latest.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (alive && m?.version) setAgentVersion(String(m.version)); })
      .catch(() => { /* keep fallback */ });
    return () => { alive = false; };
  }, []);
  const ref = agentVersion ? `v${agentVersion}` : BUILD_REF;
  const osData = buildOsData(agentVersion, ref);

  const licenseKey = organization?.license_key ?? '—';
  const orgName = organization?.name ?? '—';
  const subStatus = organization?.subscription_status ?? 'trial';
  const subType = organization?.subscription_type ?? 'monthly';
  const totalLicenses = organization?.license_count ?? 0;
  const usedLicenses = agents.length;
  const trialEnds = organization?.trial_ends_at
    ? new Date(organization.trial_ends_at).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      })
    : '—';

  const osCounts = {
    Windows: agents.filter((a) => (a.os ?? '').toLowerCase().includes('windows')).length,
    macOS: agents.filter((a) => (a.os ?? '').toLowerCase().includes('mac')).length,
    Ubuntu: agents.filter((a) => {
      const os = (a.os ?? '').toLowerCase();
      return os.includes('ubuntu') || os.includes('linux');
    }).length,
  };

  const copyKey = async () => {
    await navigator.clipboard.writeText(licenseKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // After registration, the modal flips into "Send to employee" mode showing a
  // personalized launcher script that bakes the agent name into the install flow.
  const [postRegister, setPostRegister] = useState<{ agentName: string; os: string } | null>(null);

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentName.trim()) return;
    setCreating(true);
    try {
      await createAgent({
        agentName: newAgentName.trim(),
        osType: newAgentOS,
        department: newAgentDept,
      });
      setPostRegister({ agentName: newAgentName.trim(), os: newAgentOS });
    } finally {
      setCreating(false);
    }
  };

  const closeAddModal = () => {
    setAddOpen(false);
    setPostRegister(null);
    setNewAgentName('');
    setNewAgentDept('Unassigned');
    setNewAgentOS('Windows');
  };

  // Generate a tiny shell/batch script that:
  //   1. Drops a prefill JSON containing THIS ORG'S LICENSE KEY (and optional
  //      name) into the agent's data dir — `dirs::data_dir()/RudransAgent/`,
  //      the exact path config.rs::read_prefill() reads.
  //   2. Downloads the standard .pkg / .exe / .deb from Supabase Storage.
  //   3. Runs the installer.
  // The Rust agent auto-enrolls on first launch from this prefill (key +
  // hostname) with ZERO input from the employee. If no name is passed the agent
  // uses the PC hostname. Falls back to the manual setup screen only if the
  // prefill is missing.
  const downloadLauncher = (os: string, agentName: string) => {
    const key = (organization?.license_key ?? '').trim();
    if (!key || key === '—') {
      alert('No license key found for this organization yet — cannot build an auto-setup installer.');
      return;
    }
    const safeName = agentName.replace(/'/g, "'\\''").replace(/"/g, '\\"');
    const baseFile = agentName
      ? `Install-${agentName.replace(/[^A-Za-z0-9]+/g, '-')}`
      : 'Install-SecurityAssistant';
    // License key is always embedded; name only when the admin supplied one
    // (otherwise the agent falls back to the machine hostname).
    const prefill = agentName
      ? `{"license_key":"${key}","agent_name":"${safeName}"}`
      : `{"license_key":"${key}"}`;
    let content = '';
    let filename = '';
    let mime = 'text/plain';

    if (os === 'macOS') {
      filename = `${baseFile}.command`;
      content = `#!/bin/bash
set -e
APP_SUPPORT="$HOME/Library/Application Support/RudransAgent"
mkdir -p "$APP_SUPPORT"
cat > "$APP_SUPPORT/prefill.json" <<JSON
${prefill}
JSON
PKG="$(/usr/bin/uname -m | grep -q arm64 && echo arm64 || echo x64)"
URL="${RELEASES_BASE}/Security-Assistant-macOS-\${PKG}-${BUILD_REF}.pkg"
echo "Downloading Security Assistant for $PKG..."
curl -fL "$URL" -o /tmp/security-assistant.pkg
echo "Installing (admin password required)..."
sudo installer -pkg /tmp/security-assistant.pkg -target /
echo "Done. The agent sets itself up automatically — nothing to enter."
`;
    } else if (os === 'Windows') {
      filename = `${baseFile}.bat`;
      mime = 'application/octet-stream';
      // NSIS .exe, silent (/S). Prefill goes to %APPDATA%\RudransAgent (=
      // dirs::data_dir()/RudransAgent) so the agent's read_prefill() finds it.
      content = `@echo off
setlocal
set "APP_DATA=%APPDATA%\\RudransAgent"
if not exist "%APP_DATA%" mkdir "%APP_DATA%"
> "%APP_DATA%\\prefill.json" echo ${prefill}
set "URL=${RELEASES_BASE}/Security-Assistant-Windows-${BUILD_REF}.exe"
echo Downloading Security Assistant...
powershell -Command "Invoke-WebRequest -Uri '%URL%' -OutFile '%TEMP%\\security-assistant.exe'"
echo Installing silently...
"%TEMP%\\security-assistant.exe" /S
echo Done. Security Assistant is installing and will set itself up automatically.
pause
`;
    } else {
      filename = `${baseFile}.sh`;
      content = `#!/bin/bash
set -e
APP_SUPPORT="$HOME/.local/share/RudransAgent"
mkdir -p "$APP_SUPPORT"
cat > "$APP_SUPPORT/prefill.json" <<JSON
${prefill}
JSON
URL="${RELEASES_BASE}/security-assistant_${BUILD_REF}_amd64.deb"
echo "Downloading Security Assistant..."
curl -fL "$URL" -o /tmp/security-assistant.deb
echo "Installing (sudo password required)..."
sudo dpkg -i /tmp/security-assistant.deb || sudo apt-get install -f -y
echo "Done. The agent sets itself up automatically — nothing to enter."
`;
    }

    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <DashboardLayout>
      <div className="space-y-5">
        {/* Breadcrumb */}
        <Breadcrumb
          items={[
            { label: 'Dashboard', icon: 'ri-dashboard-line', to: '/dashboard' },
            { label: 'Agent Setup' },
          ]}
        />

        {/* Page Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-poppins font-bold text-white mb-1">Agent Setup</h1>
            <p className="text-sm text-gray-500">Deploy Security Assistant across all your employee devices</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs text-emerald-400 font-medium">Latest Version: v{agentVersion}</span>
            </span>
            <ForceUpdateButton />
            <button
              onClick={() => setAddOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/25 hover:bg-emerald-500/25 transition-colors flex items-center gap-1.5"
            >
              <i className="ri-add-line text-sm" />
              Register Agent
            </button>
          </div>
        </div>

        {/* Register Agent Modal */}
        {addOpen && (
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center px-4" onClick={closeAddModal}>
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold text-white">
                  {postRegister ? 'Send to Employee' : 'Register New Agent'}
                </h3>
                <button onClick={closeAddModal} className="text-gray-500 hover:text-white">
                  <i className="ri-close-line text-lg" />
                </button>
              </div>

              {!postRegister ? (
                <>
                  <p className="text-xs text-gray-500 mb-4">
                    Optional — only if you want a specific display name instead of the PC hostname. We&apos;ll generate an installer that bakes in the name and the license key, so the employee enters nothing. For most machines just use One-Click Auto-Setup above.
                  </p>
                  <form onSubmit={handleCreateAgent} className="space-y-3">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Agent / Employee Name</label>
                      <input
                        type="text"
                        value={newAgentName}
                        onChange={(e) => setNewAgentName(e.target.value)}
                        placeholder="e.g. Rahul Sharma"
                        required
                        className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">OS</label>
                        <select
                          value={newAgentOS}
                          onChange={(e) => setNewAgentOS(e.target.value)}
                          className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                        >
                          <option>Windows</option>
                          <option>macOS</option>
                          <option>Ubuntu</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Department</label>
                        <select
                          value={newAgentDept}
                          onChange={(e) => setNewAgentDept(e.target.value)}
                          className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                        >
                          {deptOptions.map((d) => (
                            <option key={d}>{d}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={creating}
                      className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white py-2.5 rounded-lg font-medium text-sm transition-all"
                    >
                      {creating ? 'Registering…' : 'Register Agent'}
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 mb-4">
                    <p className="text-xs text-emerald-400 font-medium flex items-center gap-1.5">
                      <i className="ri-check-line" /> Registered: {postRegister.agentName}
                    </p>
                  </div>
                  <p className="text-xs text-gray-500 mb-3 leading-relaxed">
                    Download the personalized installer for <span className="text-white">{postRegister.agentName}</span> and send it to the employee. Running it installs the agent and enrolls it automatically with this org&apos;s license key and their name — they enter nothing.
                  </p>

                  <div className="space-y-2 mb-4">
                    <button
                      onClick={() => downloadLauncher('macOS', postRegister.agentName)}
                      className="w-full flex items-center justify-between bg-dark-900 border border-dark-700 hover:border-amber-500/30 rounded-lg px-3 py-2.5 transition-colors group"
                    >
                      <span className="flex items-center gap-2 text-xs text-gray-300">
                        <i className="ri-apple-line text-amber-400" /> macOS Launcher (.command)
                      </span>
                      <i className="ri-download-line text-amber-400 group-hover:translate-y-0.5 transition-transform" />
                    </button>
                    <button
                      onClick={() => downloadLauncher('Windows', postRegister.agentName)}
                      className="w-full flex items-center justify-between bg-dark-900 border border-dark-700 hover:border-blue-500/30 rounded-lg px-3 py-2.5 transition-colors group"
                    >
                      <span className="flex items-center gap-2 text-xs text-gray-300">
                        <i className="ri-windows-line text-blue-400" /> Windows Launcher (.bat)
                      </span>
                      <i className="ri-download-line text-blue-400 group-hover:translate-y-0.5 transition-transform" />
                    </button>
                    <button
                      onClick={() => downloadLauncher('Ubuntu', postRegister.agentName)}
                      className="w-full flex items-center justify-between bg-dark-900 border border-dark-700 hover:border-orange-500/30 rounded-lg px-3 py-2.5 transition-colors group"
                    >
                      <span className="flex items-center gap-2 text-xs text-gray-300">
                        <i className="ri-ubuntu-line text-orange-400" /> Ubuntu Launcher (.sh)
                      </span>
                      <i className="ri-download-line text-orange-400 group-hover:translate-y-0.5 transition-transform" />
                    </button>
                  </div>

                  <div className="bg-dark-900 border border-dark-700 rounded-lg p-3 mb-4">
                    <p className="text-[11px] text-gray-500 mb-1 font-medium">Employee instructions</p>
                    <ol className="text-[11px] text-gray-400 space-y-0.5 list-decimal list-inside">
                      <li>Double-click the launcher file</li>
                      <li>Approve admin / UAC prompt</li>
                      <li>That&apos;s it — the agent enrolls itself automatically</li>
                    </ol>
                  </div>

                  <button
                    onClick={closeAddModal}
                    className="w-full bg-dark-700 hover:bg-dark-600 text-white py-2.5 rounded-lg font-medium text-sm transition-all"
                  >
                    Done
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Info Banner */}
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-3 flex items-start gap-3">
          <span className="w-5 h-5 flex items-center justify-center flex-shrink-0 mt-px">
            <i className="ri-information-line text-emerald-400" />
          </span>
          <p className="text-xs text-gray-400 leading-relaxed">
            Download the appropriate agent installer for each operating system. All agents automatically register with your organization using the license key below. 
            <span className="text-emerald-400"> Windows agents support silent mass-deployment via Group Policy.</span>
          </p>
        </div>

        {/* One-Click Auto-Setup (zero-touch) */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-5 h-5 flex items-center justify-center">
              <i className="ri-flashlight-line text-emerald-400 text-sm" />
            </span>
            <h3 className="text-sm font-semibold text-white">One-Click Auto-Setup</h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">Recommended</span>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Downloads an installer that already carries your organization&apos;s license key. After it
            runs, the agent enrolls itself automatically using the PC&apos;s hostname as the name —
            the employee enters <span className="text-gray-300">nothing</span>.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button
              onClick={() => downloadLauncher('Windows', '')}
              className="flex items-center justify-between bg-dark-900 border border-dark-700 hover:border-blue-500/40 rounded-lg px-3 py-2.5 transition-colors group"
            >
              <span className="flex items-center gap-2 text-xs text-gray-300">
                <i className="ri-windows-line text-blue-400" /> Windows (.bat)
              </span>
              <i className="ri-download-line text-blue-400 group-hover:translate-y-0.5 transition-transform" />
            </button>
            <button
              onClick={() => downloadLauncher('macOS', '')}
              className="flex items-center justify-between bg-dark-900 border border-dark-700 hover:border-amber-500/40 rounded-lg px-3 py-2.5 transition-colors group"
            >
              <span className="flex items-center gap-2 text-xs text-gray-300">
                <i className="ri-apple-line text-amber-400" /> macOS (.command)
              </span>
              <i className="ri-download-line text-amber-400 group-hover:translate-y-0.5 transition-transform" />
            </button>
            <button
              onClick={() => downloadLauncher('Ubuntu', '')}
              className="flex items-center justify-between bg-dark-900 border border-dark-700 hover:border-orange-500/40 rounded-lg px-3 py-2.5 transition-colors group"
            >
              <span className="flex items-center gap-2 text-xs text-gray-300">
                <i className="ri-ubuntu-line text-orange-400" /> Ubuntu (.sh)
              </span>
              <i className="ri-download-line text-orange-400 group-hover:translate-y-0.5 transition-transform" />
            </button>
          </div>
          <p className="text-[11px] text-gray-600 mt-3">
            Windows/macOS need the usual admin/UAC approval to install. Nothing else to enter — no license key, no name.
          </p>
        </div>

        {/* License Key + Org Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* License Key */}
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 flex items-center justify-center">
                  <i className="ri-key-2-line text-emerald-400 text-sm" />
                </span>
                <h3 className="text-sm font-semibold text-white">Organization License Key</h3>
              </div>
              <button
                onClick={() => setShowKey(!showKey)}
                className="text-xs text-gray-500 hover:text-gray-400 flex items-center gap-1"
              >
                <span className="w-3 h-3 flex items-center justify-center">
                  <i className={`${showKey ? 'ri-eye-off-line' : 'ri-eye-line'} text-xs`} />
                </span>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className="bg-dark-900 rounded-lg border border-dark-700 p-3 flex items-center justify-between">
              <code className="text-sm font-mono text-emerald-400 tracking-wide break-all">
                {showKey ? licenseKey : licenseKey.replace(/./g, '*').slice(0, 24)}
              </code>
              <button
                onClick={copyKey}
                className="px-2.5 py-1 rounded-md bg-dark-700 text-gray-400 text-xs hover:text-white transition-colors flex items-center gap-1.5 flex-shrink-0 ml-2"
              >
                <span className="w-3 h-3 flex items-center justify-center">
                  <i className={`${copied ? 'ri-check-line text-emerald-400' : 'ri-file-copy-line'} text-xs`} />
                </span>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-[11px] text-gray-600 mt-2">Share this key with your IT admin to deploy agents silently across all devices.</p>
          </div>

          {/* Organization Info */}
          <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-5 h-5 flex items-center justify-center">
                <i className="ri-building-line text-violet-400 text-sm" />
              </span>
              <h3 className="text-sm font-semibold text-white">Organization Details</h3>
            </div>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">Company</span>
                <span className="text-xs text-white font-medium">{orgName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">Active Licenses</span>
                <span className="text-xs text-emerald-400 font-medium">
                  {usedLicenses} / {totalLicenses}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">Subscription</span>
                <span className="text-xs text-white font-medium capitalize">
                  {subStatus} ({subType})
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  {subStatus === 'trial' ? 'Trial Ends' : 'Renews On'}
                </span>
                <span className="text-xs text-amber-400 font-medium">{trialEnds}</span>
              </div>
            </div>
          </div>
        </div>

        {/* OS Download Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {osData.map((data) => (
            <OSCard key={data.os} {...data} />
          ))}
        </div>

        {/* Mass Deployment Guide */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-5 h-5 flex items-center justify-center">
              <i className="ri-server-line text-violet-400 text-sm" />
            </span>
            <h3 className="text-sm font-semibold text-white">Mass Deployment Guide</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                title: 'Windows (GPO / Intune)',
                desc: 'Push the NSIS .exe via Group Policy or Microsoft Intune. Silent install (/S) per-user with embedded license key.',
                icon: 'ri-windows-line',
                color: 'text-blue-400',
                bg: 'bg-blue-500/10',
              },
              {
                title: 'macOS (MDM / Jamf)',
                desc: 'Deploy .pkg via Jamf Pro, Kandji, or any MDM. Supports enrollment profiles.',
                icon: 'ri-apple-line',
                color: 'text-amber-400',
                bg: 'bg-amber-500/10',
              },
              {
                title: 'Ubuntu (Ansible / Puppet)',
                desc: 'Use apt repo or .deb package. Ansible playbook available for bulk rollout.',
                icon: 'ri-ubuntu-line',
                color: 'text-orange-400',
                bg: 'bg-orange-500/10',
              },
            ].map((item) => (
              <div key={item.title} className="bg-dark-900 rounded-lg border border-dark-700 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-8 h-8 rounded-lg ${item.bg} flex items-center justify-center`}>
                    <i className={`${item.icon} ${item.color} text-sm`} />
                  </span>
                  <h4 className="text-xs font-semibold text-white">{item.title}</h4>
                </div>
                <p className="text-[11px] text-gray-500 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Uninstall — Mac one-liner */}
        <UninstallCommandCard />

        {/* Connected Agents Summary */}
        <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 flex items-center justify-center">
                <i className="ri-computer-line text-emerald-400 text-sm" />
              </span>
              <h3 className="text-sm font-semibold text-white">Connected Agents by OS</h3>
            </div>
            <span className="text-xs text-gray-500">{agents.length} total agents</span>
          </div>
          <div className="space-y-3">
            {[
              { os: 'Windows', count: osCounts.Windows, total: Math.max(totalLicenses, 1), color: 'bg-blue-500', text: 'text-blue-400' },
              { os: 'macOS', count: osCounts.macOS, total: Math.max(totalLicenses, 1), color: 'bg-amber-500', text: 'text-amber-400' },
              { os: 'Ubuntu', count: osCounts.Ubuntu, total: Math.max(totalLicenses, 1), color: 'bg-orange-500', text: 'text-orange-400' },
            ].map((item) => (
              <div key={item.os} className="flex items-center gap-4">
                <span className={`text-xs ${item.text} font-medium w-16`}>{item.os}</span>
                <div className="flex-1 bg-dark-900 rounded-full h-2 overflow-hidden">
                  <div
                    className={`${item.color} h-full rounded-full transition-all duration-500`}
                    style={{ width: `${(item.count / item.total) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-white font-medium w-8 text-right">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

// One-liner an admin can paste into a customer's Terminal to fully
// remove the endpoint agent from a Mac — LaunchAgent, config, caches,
// logs, the .app bundle itself, and TCC permission grants. The script
// is hosted from our Supabase releases bucket at a stable URL so
// support tickets can just share this line. See
// agent/src-tauri/resources/uninstall.command for the source.
function UninstallCommandCard() {
  const CMD = 'curl -fsSL https://api-ems.wellnessextract.com/storage/v1/object/public/releases/uninstall-mac.sh | bash';
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — user can still select the text manually */ }
  };
  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-5 h-5 flex items-center justify-center">
          <i className="ri-delete-bin-line text-rose-400 text-sm" />
        </span>
        <h3 className="text-sm font-semibold text-white">Uninstall from Mac (Terminal)</h3>
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
        Paste this on the target Mac's Terminal. Removes the LaunchAgent, running processes,
        config, cache, logs, the app bundle, and resets Screen Recording / Accessibility grants.
        Safe to run multiple times.
      </p>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-[11px] font-mono text-emerald-300 overflow-x-auto whitespace-nowrap select-all">
          {CMD}
        </code>
        <button
          type="button"
          onClick={copy}
          className={`px-3 py-2 rounded-lg text-[11px] font-medium border transition-colors flex items-center gap-1.5 ${
            copied
              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
              : 'bg-dark-900 border-dark-700 text-gray-300 hover:bg-dark-700/60'
          }`}
          aria-label="Copy uninstall command"
        >
          <i className={copied ? 'ri-check-line' : 'ri-file-copy-line'} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-[11px] text-gray-500 mt-2">
        Prompts once for admin password if the app is in <code className="text-gray-400">/Applications</code>.
        Reboot recommended after — macOS caches Login Items in memory until next login.
      </p>
    </div>
  );
}
/**
 * "Force update all agents" — one-click org-wide push that wakes every
 * agent's Tauri updater loop immediately instead of waiting on its
 * 60 s / 10 min poll. See `agent-force-update` edge function and
 * `wake_updater()` in the agent's lib.rs.
 *
 * Agents on v0.6.23 or older don't have the realtime handler yet, so
 * they'll silently ignore the ring and rely on their normal poll. Once
 * they upgrade past v0.6.24, this button starts working for them.
 */
function ForceUpdateButton() {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const forceUpdate = async () => {
    setBusy(true);
    setToast(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/agent-force-update`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session?.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}), // empty → org-wide fan-out via JWT
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setToast({
        kind: 'ok',
        text: `Ping sent to ${j.notified}/${j.total} agents. Agents on v0.6.24+ will check + install immediately; older versions upgrade on their next normal poll.`,
      });
    } catch (e) {
      setToast({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={forceUpdate}
        disabled={busy}
        className="px-3 py-1.5 rounded-lg bg-blue-500/15 text-blue-400 text-xs font-medium border border-blue-500/25 hover:bg-blue-500/25 disabled:opacity-50 transition-colors flex items-center gap-1.5"
        title="Ring every agent's updater to check for the latest version immediately."
      >
        <i className={`ri-refresh-line text-sm ${busy ? 'animate-spin' : ''}`} />
        {busy ? 'Sending…' : 'Force update all agents'}
      </button>
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 max-w-md px-4 py-3 rounded-lg border text-sm shadow-lg ${
          toast.kind === 'ok'
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
            : 'border-red-500/40 bg-red-500/10 text-red-300'
        }`}
             onClick={() => setToast(null)}
             role="status">
          {toast.text}
        </div>
      )}
    </>
  );
}
