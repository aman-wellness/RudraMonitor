import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import OSCard from './components/OSCard';
import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useAgents } from '@/lib/dataHooks';
import { supabase } from '@/lib/supabase';

const RELEASES_BASE = 'https://api.rudrans.com/storage/v1/object/public/releases';
// Builds are produced by .github/workflows/build-agent.yml on every workflow_dispatch / tag push.
// File names embed the git ref (`v0.2.0` for tag pushes, `main` for branch builds).
// We default to the latest tagged release and fetch the actual current version
// from latest.json at runtime so the Setup page never drifts behind a code change.
const BUILD_REF = 'v0.2.3';
const FALLBACK_VERSION = '0.2.3';

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
        filename: `Rudrans-Agent-macOS-arm64-${ref}.pkg`,
        url: `${RELEASES_BASE}/Rudrans-Agent-macOS-arm64-${ref}.pkg`,
        size: '~4 MB',
        version,
      },
      {
        label: 'Intel (.pkg)',
        filename: `Rudrans-Agent-macOS-x64-${ref}.pkg`,
        url: `${RELEASES_BASE}/Rudrans-Agent-macOS-x64-${ref}.pkg`,
        size: '~4 MB',
        version,
      },
    ],
    steps: [
      'Download the .pkg matching your Mac (Apple Silicon = M1/M2/M3, Intel = older)',
      'IMPORTANT — clear Gatekeeper quarantine: open Terminal and run: xattr -dr com.apple.quarantine ~/Downloads/Rudrans-Agent-macOS-arm64-*.pkg',
      'OR if you prefer the GUI: double-click .pkg → "Done" on the warning → System Settings → Privacy & Security → scroll down → click "Open Anyway"',
      'Double-click the .pkg and follow the installer (admin password required)',
      'After install, grant Screen Recording + Accessibility in System Settings → Privacy & Security → Screen Recording (toggle Rudrans Agent on)',
      'Launch Rudrans Agent from Applications — enrollment dialog appears',
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
        label: 'Rudrans Agent (.msi)',
        filename: `Rudrans-Agent-Windows-${ref}.msi`,
        url: `${RELEASES_BASE}/Rudrans-Agent-Windows-${ref}.msi`,
        size: '~12 MB',
        version,
      },
    ],
    steps: [
      'Download the .msi installer',
      'Double-click and follow the installer (admin/UAC prompt)',
      'Enrollment dialog opens — paste the License Key below and your name',
      'Agent runs hidden in the background; auto-starts on every reboot',
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
        filename: `rudrans-agent_${ref}_amd64.deb`,
        url: `${RELEASES_BASE}/rudrans-agent_${ref}_amd64.deb`,
        size: '~5 MB',
        version,
      },
    ],
    steps: [
      'Download the .deb package',
      'Run `sudo dpkg -i rudrans-agent_*.deb` (or double-click on GNOME)',
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

  // Pull the live release version from the same latest.json the desktop agents
  // poll for auto-updates. This way bumping the version in tauri.conf.json (+
  // shipping a new build) is the only step admins need — the dashboard's
  // "Latest Version" label and per-card version chips update automatically.
  const [agentVersion, setAgentVersion] = useState(FALLBACK_VERSION);
  useEffect(() => {
    let alive = true;
    fetch(`${RELEASES_BASE}/latest.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (alive && m?.version) setAgentVersion(String(m.version)); })
      .catch(() => { /* keep fallback */ });
    return () => { alive = false; };
  }, []);
  // Derive the file-ref from the live version (e.g. "0.2.0" → "v0.2.0") so the
  // download URLs always match the artifacts CI just uploaded. Fall back to the
  // hard-coded BUILD_REF if latest.json is unreachable for some reason.
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
  //   1. Drops a prefill JSON containing the agent name in the agent's data dir.
  //   2. Downloads the standard .pkg / .msi / .deb from Supabase Storage.
  //   3. Runs the installer.
  // The Rust agent reads this prefill on first launch, hides the name field, and only
  // asks the employee for the license key.
  const downloadLauncher = (os: string, agentName: string) => {
    const safeName = agentName.replace(/'/g, "'\\''").replace(/"/g, '\\"');
    const baseFile = `Install-${agentName.replace(/[^A-Za-z0-9]+/g, '-')}`;
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
{"agent_name":"${safeName}"}
JSON
PKG="$(/usr/bin/uname -m | grep -q arm64 && echo arm64 || echo x64)"
URL="${RELEASES_BASE}/Rudrans-Agent-macOS-\${PKG}-${BUILD_REF}.pkg"
echo "Downloading Rudrans Agent for $PKG..."
curl -fL "$URL" -o /tmp/rudrans.pkg
echo "Installing (admin password required)..."
sudo installer -pkg /tmp/rudrans.pkg -target /
echo "Done. Launch Rudrans Agent from /Applications and enter your License Key."
`;
    } else if (os === 'Windows') {
      filename = `${baseFile}.bat`;
      mime = 'application/octet-stream';
      content = `@echo off
setlocal
set "APP_DATA=%APPDATA%\\RudransAgent"
if not exist "%APP_DATA%" mkdir "%APP_DATA%"
> "%APP_DATA%\\prefill.json" echo {"agent_name":"${safeName}"}
set "URL=${RELEASES_BASE}/Rudrans-Agent-Windows-${BUILD_REF}.msi"
echo Downloading Rudrans Agent...
powershell -Command "Invoke-WebRequest -Uri '%URL%' -OutFile '%TEMP%\\rudrans.msi'"
echo Installing (UAC prompt may appear)...
msiexec /i "%TEMP%\\rudrans.msi" /qb
echo Done. Launch Rudrans Agent and enter your License Key.
pause
`;
    } else {
      filename = `${baseFile}.sh`;
      content = `#!/bin/bash
set -e
APP_SUPPORT="$HOME/.local/share/RudransAgent"
mkdir -p "$APP_SUPPORT"
cat > "$APP_SUPPORT/prefill.json" <<JSON
{"agent_name":"${safeName}"}
JSON
URL="${RELEASES_BASE}/rudrans-agent_${BUILD_REF}_amd64.deb"
echo "Downloading Rudrans Agent..."
curl -fL "$URL" -o /tmp/rudrans.deb
echo "Installing (sudo password required)..."
sudo dpkg -i /tmp/rudrans.deb || sudo apt-get install -f -y
echo "Done. Launch Rudrans Agent and enter your License Key."
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
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-dashboard-line" /></span>
            Dashboard
          </span>
          <i className="ri-arrow-right-s-line text-gray-600" />
          <span className="text-white font-medium">Agent Setup</span>
        </div>

        {/* Page Header */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-poppins font-bold text-white mb-1">Agent Setup</h1>
            <p className="text-sm text-gray-500">Deploy Rudrans agents across all your employee devices</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs text-emerald-400 font-medium">Latest Version: v{agentVersion}</span>
            </span>
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
                    Pre-register a machine. After registration we&apos;ll generate a personalized installer that bakes in the employee name — they only enter the license key.
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
                    Download the personalized installer for <span className="text-white">{postRegister.agentName}</span> and send it to the employee. Running it will install the agent and pre-fill their name — they only enter the License Key.
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
                      <li>Enter the License Key when prompted</li>
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
                desc: 'Push .msi via Group Policy or Microsoft Intune. Silent install with embedded license key.',
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