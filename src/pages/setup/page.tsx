import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import OSCard from './components/OSCard';
import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useAgents } from '@/lib/dataHooks';

const RELEASES_BASE = 'https://ttjazaxjhzvrzhptrpmd.supabase.co/storage/v1/object/public/releases';
const AGENT_VERSION = '0.1.0';

const osData = [
  {
    os: 'macOS',
    icon: 'ri-apple-line',
    color: 'text-amber-400',
    borderColor: 'border-amber-500/20',
    bgColor: 'bg-amber-500/10',
    minVersion: 'macOS 12+',
    arch: 'Intel / Apple Silicon',
    downloads: [
      {
        label: 'TrackForce Agent (.pkg)',
        filename: `TrackForce-Agent-macOS-${AGENT_VERSION}.pkg`,
        url: `${RELEASES_BASE}/TrackForce-Agent-macOS-${AGENT_VERSION}.pkg`,
        size: '3.7 MB',
        version: AGENT_VERSION,
      },
    ],
    steps: [
      'Download the .pkg installer',
      'Double-click the .pkg and follow the installer (admin password required)',
      'Enrollment dialog opens — paste the License Key below and your name',
      'Agent goes silent in the background; auto-starts on every reboot',
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
        label: 'TrackForce Agent (.msi) — coming soon',
        filename: `TrackForce-Agent-Windows-${AGENT_VERSION}.msi`,
        url: '',
        size: '—',
        version: AGENT_VERSION,
      },
    ],
    steps: [
      'Build artifact required: run `npm run tauri build -- --bundles msi` on a Windows host',
      'Upload the .msi to the `releases` Supabase Storage bucket',
      'Once uploaded the Download button on this card becomes live',
    ],
  },
  {
    os: 'Ubuntu',
    icon: 'ri-ubuntu-line',
    color: 'text-orange-400',
    borderColor: 'border-orange-500/20',
    bgColor: 'bg-orange-500/10',
    minVersion: 'Ubuntu 20.04+',
    arch: 'x64 / ARM64',
    downloads: [
      {
        label: 'Debian Package (.deb) — coming soon',
        filename: `trackforce-agent_${AGENT_VERSION}_amd64.deb`,
        url: '',
        size: '—',
        version: AGENT_VERSION,
      },
    ],
    steps: [
      'Build artifact required: run `npm run tauri build -- --bundles deb` on a Linux host',
      'Upload the .deb to the `releases` Supabase Storage bucket',
      'Once uploaded the Download button on this card becomes live',
    ],
  },
];

export default function SetupPage() {
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentDept, setNewAgentDept] = useState('Unassigned');
  const [newAgentOS, setNewAgentOS] = useState('Windows');
  const [creating, setCreating] = useState(false);
  const { organization } = useAuth();
  const { agents, createAgent } = useAgents();

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
      setNewAgentName('');
      setNewAgentDept('Unassigned');
      setNewAgentOS('Windows');
      setAddOpen(false);
    } finally {
      setCreating(false);
    }
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
            <p className="text-sm text-gray-500">Deploy TrackForce agents across all your employee devices</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs text-emerald-400 font-medium">Latest Version: v2.4.1</span>
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
          <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center px-4" onClick={() => setAddOpen(false)}>
            <div className="bg-dark-800 border border-dark-700 rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold text-white">Register New Agent</h3>
                <button onClick={() => setAddOpen(false)} className="text-gray-500 hover:text-white">
                  <i className="ri-close-line text-lg" />
                </button>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                Pre-register a machine. The desktop agent will use this entry on first launch with the org license key.
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
                      {['Unassigned','Development','HR','Finance','Design','Sales','Support','Marketing'].map((d) => (
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