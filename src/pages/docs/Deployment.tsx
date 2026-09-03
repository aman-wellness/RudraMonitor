// Public docs: enterprise deployment guide. Covers Active Directory Group
// Policy Software Installation, Microsoft Intune (Entra ID managed devices),
// and SCCM / Configuration Manager. The MSI + enroll.dat pair that the
// per-org download endpoint returns is already silent-install-friendly
// (perMachine + quiet + norestart), so at scale the deployment story is
// about wrapping that pair for each mass-deploy engine.

import DocsLayout from './DocsLayout';

const SECTIONS = [
  { id: 'prereq',        label: '1. Prerequisites' },
  { id: 'ad-gpo',        label: '2. Active Directory (GPO)' },
  { id: 'intune',        label: '3. Microsoft Intune (Entra)' },
  { id: 'sccm',          label: '4. SCCM' },
  { id: 'uninstall',     label: '5. Silent uninstall' },
  { id: 'verify',        label: '6. Verification checklist' },
  { id: 'faq',           label: 'FAQ' },
];

export default function Deployment() {
  return (
    <DocsLayout
      title="Roll out Security Assistant across your fleet"
      subtitle="Enterprise deployment via AD Group Policy, Microsoft Intune (Entra ID), and SCCM. All three deploy the same MSI — the license key is embedded, so there's no per-machine configuration step."
      sections={SECTIONS}
      accent="amber"
    >
      <article className="prose prose-invert max-w-4xl">
        <header className="mb-8"></header>

        <section id="prereq" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">1. Prerequisites</h2>
          <ul className="text-gray-300 space-y-1.5 text-sm">
            <li>• A domain admin (AD/GPO) or an Intune admin (Entra ID) account.</li>
            <li>• Windows 10 1809 or later on the target machines (Server 2019+ also supported).</li>
            <li>• Machines are either domain-joined (AD), Entra-joined (Intune), or hybrid-joined (both).</li>
            <li>• Outbound HTTPS to <code className="text-emerald-300">api-ems.wellnessextract.com</code> on port 443 (no proxy allowlisting beyond this hostname needed).</li>
            <li>• The MSI file from your admin portal — Settings → Deploy → Download Windows MSI.
              The download is org-scoped: it carries your license key embedded, so every install auto-enrols against your org without any input.</li>
          </ul>
        </section>

        <section id="ad-gpo" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">2. Active Directory (Group Policy)</h2>
          <p className="text-gray-300 text-sm mb-3">
            Uses <strong>Software Installation</strong> in Group Policy Management Console. This is the
            classic domain-controller path — machines pick the MSI up on their next Group Policy refresh
            and install at boot as SYSTEM.
          </p>
          <ol className="text-gray-300 text-sm space-y-2 list-decimal ml-5">
            <li>Copy <code className="text-emerald-300">Security-Assistant.msi</code> to a UNC share readable
              by <strong>Domain Computers</strong> (typical: <code className="text-emerald-300">\\dc01\Software\SecurityAssistant\</code>).
              Right-click the share → Properties → Security → give <em>Domain Computers</em> Read.</li>
            <li>Open <strong>Group Policy Management Console</strong> on the DC.
              Right-click the OU that holds the endpoints → <em>Create a GPO in this domain</em>.
              Name it "Security Assistant Deploy".</li>
            <li>Right-click the new GPO → <em>Edit</em>. Under
              <strong> Computer Configuration → Policies → Software Settings → Software installation</strong>,
              right-click the pane → <em>New → Package</em>.</li>
            <li>Browse the UNC path to your MSI. <strong>Important:</strong> use the UNC path, not a mapped
              drive — a mapped drive doesn't exist yet during the SYSTEM boot-time install.</li>
            <li>Choose <em>Assigned</em> (not Published). Assigned = installed on next reboot; Published =
              opt-in via Add/Remove Programs.</li>
            <li>Close GPMC. On a target machine, run <code className="text-emerald-300">gpupdate /force</code> and reboot;
              the agent installs during the boot sequence. Alternatively wait for the next scheduled Group
              Policy refresh (default 90 min + 30 min jitter).</li>
            <li>Verify: on the target, <code className="text-emerald-300">Get-Service Rudrans*</code> or the presence
              of the scheduled task <em>Security Assistant</em> under Task Scheduler → Task Scheduler Library →
              SecurityAssistant.</li>
          </ol>
          <div className="mt-4 p-3 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 text-xs">
            <strong>Tip:</strong> For the initial pilot, target a small OU (say, <em>Staging → Desks</em>) and
            confirm agents appear online in the Fleet dashboard before widening to <em>All Domain
            Computers</em>. GPMC's WMI filter on the OU lets you exclude a specific machine list if needed.
          </div>
        </section>

        <section id="intune" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">3. Microsoft Intune (Entra ID)</h2>
          <p className="text-gray-300 text-sm mb-3">
            Uses the <strong>Line-of-Business App</strong> or <strong>Win32 App</strong> flow from the
            Intune admin center. Win32 App is preferred because it supports install-behaviour "System",
            silent detection, and a retry loop.
          </p>

          <h3 className="text-white text-base font-semibold mt-4 mb-2">3a. Package the MSI as an .intunewin file</h3>
          <ol className="text-gray-300 text-sm space-y-2 list-decimal ml-5">
            <li>Download the <strong>Microsoft Win32 Content Prep Tool</strong>{' '}
              (<code className="text-emerald-300">IntuneWinAppUtil.exe</code>) from Microsoft — the tool is
              free and unsigned but shipped by MS.</li>
            <li>Put <code className="text-emerald-300">Security-Assistant.msi</code> into a folder by itself, say
              <code className="text-emerald-300"> C:\Deploy\SA\</code>.</li>
            <li>Run:
              <pre className="mt-2 bg-dark-950 border border-dark-700 rounded p-3 text-emerald-300 text-xs font-mono overflow-x-auto">
{`IntuneWinAppUtil.exe -c C:\\Deploy\\SA -s Security-Assistant.msi -o C:\\Deploy\\Output`}
              </pre>
              You'll get <code className="text-emerald-300">Security-Assistant.intunewin</code> in the output folder.</li>
          </ol>

          <h3 className="text-white text-base font-semibold mt-5 mb-2">3b. Add the app to Intune</h3>
          <ol className="text-gray-300 text-sm space-y-2 list-decimal ml-5">
            <li>Sign in to <strong>Microsoft Intune admin center</strong> (intune.microsoft.com) →
              <em> Apps → Windows → Add → Windows app (Win32)</em>.</li>
            <li>Upload the <code className="text-emerald-300">.intunewin</code> file. Intune auto-detects the MSI
              inside and pre-fills the product code + version.</li>
            <li><strong>Program</strong> tab:
              <ul className="ml-5 mt-1 space-y-1">
                <li>• Install command: <code className="text-emerald-300">msiexec /i "Security-Assistant.msi" /quiet /norestart</code></li>
                <li>• Uninstall command: <code className="text-emerald-300">msiexec /x {'{UPGRADE-CODE}'} /quiet /norestart</code>
                  {' '}(Intune fills the UpgradeCode automatically if you leave it as
                  <code className="text-emerald-300"> {'{ProductCode}'} </code>).</li>
                <li>• Install behaviour: <em>System</em>.</li>
                <li>• Device restart behaviour: <em>App install may force a device restart</em> → <em>No specific action</em>.</li>
              </ul>
            </li>
            <li><strong>Requirements</strong> tab: OS architecture <em>x64</em>, minimum OS <em>Windows 10 1809</em>.</li>
            <li><strong>Detection rules</strong> tab → <em>Manually configure</em>:
              <ul className="ml-5 mt-1 space-y-1">
                <li>• Rule type: MSI</li>
                <li>• MSI product code: leave the auto-detected value</li>
                <li>• MSI product version check: <em>No</em> (agent auto-updates itself, so future versions
                  detected as installed).</li>
              </ul>
            </li>
            <li><strong>Assignments</strong> tab: choose <em>All Devices</em> or a specific Entra dynamic
              group. Set as <em>Required</em> (not <em>Available</em>) so it installs without user opt-in.</li>
            <li><em>Review + Create</em>. Intune Management Extension picks the app up on its next
              cycle (usually within 15 min). Agents appear in your Fleet dashboard shortly after each
              endpoint's next check-in.</li>
          </ol>
          <div className="mt-4 p-3 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 text-xs">
            <strong>Intune Device ID vs your Fleet:</strong> the agent doesn't consume the Intune Device ID
            or your Entra tenant ID for enrolment — enrolment uses the license key embedded in the MSI.
            The Intune-side deployment status ("Installed" / "Failed" per device) still works normally
            through Intune's own reporting.
          </div>
        </section>

        <section id="sccm" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">4. SCCM / Configuration Manager</h2>
          <p className="text-gray-300 text-sm mb-3">
            Same MSI, packaged as an <strong>Application</strong> in the SCCM console. For sites already
            using SCCM this path is usually preferred over GPO because deployment status, per-device retry,
            and rollout scheduling are all first-class SCCM features.
          </p>
          <ol className="text-gray-300 text-sm space-y-2 list-decimal ml-5">
            <li>Copy the MSI to a distribution point share readable by <em>Configuration Manager Client</em>.</li>
            <li>In the SCCM console: <em>Software Library → Applications → Create Application</em>.
              Choose <em>Automatically detect information about this application from installation files</em>
              and browse to the MSI.</li>
            <li>The wizard fills product name, publisher, and detection rule (MSI ProductCode).
              Set <em>Installation program</em> to
              <code className="text-emerald-300"> msiexec /i "Security-Assistant.msi" /quiet /norestart</code>.</li>
            <li>Set the deployment type's installation behaviour to <em>Install for system</em>, logon requirement
              <em> Whether or not a user is logged on</em>, and user interaction <em>Hidden</em>.</li>
            <li>Distribute the application to your DP group, then <em>Deploy</em> to a device collection with
              purpose <em>Required</em>.</li>
          </ol>
        </section>

        <section id="uninstall" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">5. Silent uninstall</h2>
          <p className="text-gray-300 text-sm mb-2">Same MSI carries the uninstall path:</p>
          <pre className="bg-dark-950 border border-dark-700 rounded p-3 text-emerald-300 text-xs font-mono overflow-x-auto">
{`msiexec /x "Security-Assistant.msi" /quiet /norestart
# or by product code:
msiexec /x {8c7b9c41-3e52-4d2f-9c8e-a1f6e2d7b3a5} /quiet /norestart`}
          </pre>
          <p className="text-gray-400 text-xs mt-2">
            The MSI uninstall sweep removes: agent files, scheduled tasks, the USB-block policy, the
            proxy hijack registry (per real user), Uninstall entries, and every AppData directory.
            See the source at <code className="text-gray-300">agent/src-tauri/wix/cleanup-fragment.wxs</code>.
          </p>
        </section>

        <section id="verify" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">6. Verification checklist</h2>
          <ul className="text-gray-300 space-y-1.5 text-sm">
            <li>✅ <em>Fleet dashboard shows the machine as online</em> within 5 minutes of MSI install.</li>
            <li>✅ <em>Agent detail → Inventory tab</em> populates within 30 s of the first boot cycle.</li>
            <li>✅ <em>Scheduled task <code className="text-emerald-300">SecurityAssistant\Security Assistant</code></em> exists.</li>
            <li>✅ The <em>Antivirus</em> app appears in the macOS Screen Recording popover when Live/Video runs (Mac agents only).</li>
            <li>❌ If a machine doesn't come online: check outbound HTTPS to
              <code className="text-emerald-300"> api-ems.wellnessextract.com:443 </code> is allowed by the customer's proxy.</li>
          </ul>
        </section>

        <section id="faq" className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-3">FAQ</h2>
          <div className="space-y-4 text-sm">
            <div>
              <p className="text-white font-medium">Do I need a per-machine license key at deploy time?</p>
              <p className="text-gray-400 mt-1">
                No — the MSI you download from your admin portal has your org's license key already baked in.
                Every install picks it up automatically. That's why the MSI is org-scoped, not per-device.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">Will agents auto-update after deployment?</p>
              <p className="text-gray-400 mt-1">
                Yes. The agent's built-in updater checks the release bucket every 10 minutes and applies
                signed updates silently. Once GPO/Intune has placed v0.7.X on a machine, all future versions
                install without another Intune / GPO cycle.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">Can the same GPO deploy to Mac endpoints?</p>
              <p className="text-gray-400 mt-1">
                No — Group Policy is Windows-only. For Mac fleets use Jamf Pro / Kandji / Mosyle or Intune's
                Apple MDM channel, deploying the notarised <code className="text-gray-300">Security-Assistant.pkg</code> from
                the same downloads page. Install command:
                {' '}<code className="text-emerald-300">installer -pkg "Security-Assistant.pkg" -target /</code>.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">Does the agent register itself against Entra ID?</p>
              <p className="text-gray-400 mt-1">
                It <em>reads</em> the Entra join status of the machine for the Inventory tab (via
                <code className="text-gray-300"> dsregcmd /status </code>), but it does not <em>enrol</em> the
                machine into Entra. Entra join is a separate Intune / manual step; the agent respects it
                either way.
              </p>
            </div>
            <div>
              <p className="text-white font-medium">What if the endpoint uses a proxy?</p>
              <p className="text-gray-400 mt-1">
                The agent honours the system proxy set in WinHTTP / Internet Options. Allow the outbound
                hostname <code className="text-emerald-300">api-ems.wellnessextract.com</code> through your proxy;
                the agent picks the proxy up automatically.
              </p>
            </div>
          </div>
        </section>
      </article>
    </DocsLayout>
  );
}
