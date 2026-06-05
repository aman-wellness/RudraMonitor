import DocsLayout, { Section, Sub, P, Steps, Bullets, Code, Callout, Shot, KV } from './DocsLayout';

const sections = [
  { id: 'getting-started',  label: '1. Getting started' },
  { id: 'dashboard',        label: '2. Dashboard tour' },
  { id: 'agent',            label: '3. Agent install' },
  { id: 'monitoring',       label: '4. Monitoring' },
  { id: 'screenshots',      label: '5. Screenshots & video' },
  { id: 'alerts',           label: '6. Alerts' },
  { id: 'dlp',              label: '7. DLP (USB + Email)' },
  { id: 'reports',          label: '8. Reports' },
  { id: 'em-overview',      label: '9. Employee Management' },
  { id: 'em-integrations',  label: '10. M365 / Google connect' },
  { id: 'em-employees',     label: '11. Add employees' },
  { id: 'em-groups',        label: '12. Groups & Teams' },
  { id: 'em-managers',      label: '13. Managers' },
  { id: 'em-credentials',   label: '14. Credentials Vault' },
  { id: 'em-hardware',      label: '15. IT Hardware' },
  { id: 'em-offboarding',   label: '16. Offboarding' },
  { id: 'admin-portal',     label: '17. Admin Portal' },
  { id: 'subscription',     label: '18. Subscription' },
  { id: 'troubleshooting',  label: '19. Troubleshooting' },
];

export default function UserGuide() {
  return (
    <DocsLayout
      title="Customer User Guide"
      subtitle="A step-by-step walkthrough of every customer-facing feature in Rudrans."
      sections={sections}
      accent="emerald"
    >
      {/* 1. GETTING STARTED */}
      <Section id="getting-started" title="1. Getting started">
        <P>Rudrans is an enterprise monitoring + employee-management SaaS for Windows, macOS, and Ubuntu workforces. This guide walks you through every screen.</P>

        <Sub title="1.1 Sign up (free 14-day trial)">
          <Steps items={[
            <>Open <code className="text-emerald-300">https://ems.rudrans.com</code> and click <strong>Start Free Trial</strong>.</>,
            <>Enter your work email, full name, and a password.</>,
            <>Verify your email (we send a 6-digit code or a magic link).</>,
            <>Pick your organisation name, country, and phone number on the <em>complete-signup</em> screen.</>,
            <>You land on the Dashboard with a 14-day trial — every feature unlocked.</>,
          ]} />
          <Shot caption="Sign-up page with email + password" />
        </Sub>

        <Sub title="1.2 Login">
          <P>After signup, sign in at <code className="text-emerald-300">/login</code>. Three options:</P>
          <Bullets items={[
            'Email + password',
            <>Sign in with Microsoft (Microsoft Entra / 365 work account)</>,
            <>Sign in with Google (any Google account; for Workspace orgs use your @company.com address)</>,
          ]} />
        </Sub>

        <Sub title="1.3 Roles inside your organisation">
          <KV k="Owner" v="The person who signed up. Owns the org, can change billing." />
          <KV k="Org Admin" v="Full read + write access to everything inside your org." />
          <KV k="Viewer" v="Read-only — sees dashboards, employees, hardware, credentials list but cannot modify or send anything." />
        </Sub>
      </Section>

      {/* 2. DASHBOARD */}
      <Section id="dashboard" title="2. Dashboard tour">
        <P>The Dashboard is your home screen at <code className="text-emerald-300">/dashboard</code>. It shows real-time data from every connected agent.</P>
        <Shot caption="Dashboard hero with active-agent count + alert summary" />
        <Sub title="Top-row KPI tiles">
          <Bullets items={[
            <><strong>Active agents</strong> — devices that pinged in the last 2 minutes.</>,
            <><strong>Idle agents</strong> — running but no input for &gt; 5 min.</>,
            <><strong>Offline</strong> — last seen &gt; 150 seconds ago.</>,
            <><strong>Alerts (24h)</strong> — count of unresolved alerts in the last day.</>,
          ]} />
        </Sub>
        <Sub title="Sidebar navigation">
          <Bullets items={[
            <>Dashboard · Agents · Monitoring · Alerts · DLP · System Health · Performance · Reports · Agent Setup</>,
            <>Employees · Groups &amp; Teams · Managers · Credentials Vault · IT Hardware · Offboarding · Integrations</>,
            <>Admin Portal (org settings, subscription, users, departments)</>,
          ]} />
        </Sub>
      </Section>

      {/* 3. AGENT */}
      <Section id="agent" title="3. Installing the desktop agent">
        <Sub title="3.1 Download the installer">
          <Steps items={[
            <>Open <strong>Agent Setup</strong> from the sidebar (<code className="text-emerald-300">/setup</code>).</>,
            <>Choose your platform: Windows (.exe / .msi), macOS Apple Silicon (.dmg), macOS Intel (.dmg), Linux Ubuntu (.AppImage / .deb).</>,
            <>Copy your org's <strong>License key</strong> shown on the same page.</>,
          ]} />
          <Shot caption="Agent Setup page with platform downloads" />
        </Sub>
        <Sub title="3.2 Install + enroll">
          <Steps items={[
            <><strong>Windows</strong>: run the .exe as administrator; UAC prompt grants the watchdog service.</>,
            <><strong>macOS</strong>: drag to Applications, grant Screen Recording + Accessibility under System Settings → Privacy &amp; Security.</>,
            <><strong>Ubuntu</strong>: <code>chmod +x rudrans-agent.AppImage &amp;&amp; ./rudrans-agent.AppImage</code></>,
            <>On first launch, paste the License key. Agent registers itself and starts reporting within 30 seconds.</>,
          ]} />
          <Callout kind="info" title="Auto-updater">
            <P>Each agent silently checks for new builds. Releases publish a signed manifest at <code>/storage/v1/object/public/releases/latest.json</code>. New versions install on next launch — no IT touch required.</P>
          </Callout>
        </Sub>
        <Sub title="3.3 Resilience">
          <Bullets items={[
            'A sibling watchdog process auto-respawns the agent within 5 seconds of any kill attempt.',
            'Uninstall is blocked unless triggered through your IT admin portal.',
            'Offline-status detection: any agent silent for > 150s is flagged red.',
          ]} />
        </Sub>
      </Section>

      {/* 4. MONITORING */}
      <Section id="monitoring" title="4. Monitoring">
        <P>The Monitoring page (<code className="text-emerald-300">/monitoring</code>) is your live feed.</P>
        <Sub title="Filters">
          <Bullets items={[
            'By department / team',
            'By status (active / idle / offline)',
            'By work app (Chrome, Slack, VS Code, etc.)',
            'Search by employee name or machine name',
          ]} />
        </Sub>
        <Sub title="Per-agent detail">
          <P>Click any agent row to open <code className="text-emerald-300">/agents/:id</code>:</P>
          <Bullets items={[
            'Live timeline of app windows + page titles + URLs (Chrome / Edge / Safari / Firefox)',
            'Productive vs Unproductive classification (rules + AI)',
            'Idle/active heatmap for the day',
            'Last 24h screenshot strip',
            'System health: CPU, RAM, disk, network counters',
          ]} />
          <Shot caption="Agent detail page with timeline + screenshots" />
        </Sub>
      </Section>

      {/* 5. SCREENSHOTS */}
      <Section id="screenshots" title="5. Screenshots & video recording">
        <Sub title="Screenshots">
          <Bullets items={[
            'Configurable interval (default every 5 minutes when active).',
            'Stored encrypted; thumbnails in the agent detail strip; click to open full-resolution preview.',
            'Auto-purged based on Data Retention setting (Admin Portal → Settings).',
          ]} />
        </Sub>
        <Sub title="Video recording">
          <Bullets items={[
            'Triggered on-demand or by AI alerts (e.g. unauthorized USB transfer).',
            'Records the active screen at low frame-rate, encoded with hardware acceleration.',
            'Click thumbnail in agent detail to play inline.',
          ]} />
        </Sub>
      </Section>

      {/* 6. ALERTS */}
      <Section id="alerts" title="6. Alerts">
        <P>Alerts page (<code className="text-emerald-300">/alerts</code>) shows every AI- or rule-classified anomaly.</P>
        <Bullets items={[
          'Severity: low / medium / high / critical',
          'Type: dlp_usb · dlp_email_attach · idle_violation · app_blocklist · custom_rule',
          'Each row → click → detail with related screenshot/video + AI reasoning.',
          'Resolved alerts disappear from the badge counter in the sidebar.',
        ]} />
      </Section>

      {/* 7. DLP */}
      <Section id="dlp" title="7. DLP — Data Loss Prevention">
        <P>DLP detects unauthorized data transfer in real time.</P>
        <Sub title="USB monitoring">
          <Bullets items={[
            'Watches mounted external storage with the Rust notify crate.',
            'Every file copied/moved is captured + classified by Anthropic Claude (primary) or OpenAI GPT (fallback).',
            'Flagged transfers trigger Microsoft Graph email alert to IT.',
          ]} />
        </Sub>
        <Sub title="Email attachment monitoring">
          <Bullets items={[
            'EmailComposeTracker hooks Outlook + Gmail web composers + native Outlook on Windows.',
            'Personal-mail attachments (Gmail/Hotmail/Yahoo) flagged by default.',
            'Whitelist authorized domains in Admin Portal → DLP Settings.',
          ]} />
        </Sub>
        <Callout kind="warn" title="Default policy">
          ALL USB transfers + ALL personal-mail attachments are flagged by default. To allow specific domains, add them to the authorized-domains whitelist.
        </Callout>
      </Section>

      {/* 8. REPORTS */}
      <Section id="reports" title="8. Reports">
        <P>Reports page (<code className="text-emerald-300">/reports</code>) lets you export aggregate data.</P>
        <Bullets items={[
          'Daily / weekly / monthly productivity rollups',
          'Per-employee app usage breakdown',
          'Idle vs active heatmap',
          'Top apps + top sites',
          'CSV export of any report',
        ]} />
      </Section>

      {/* 9. EM OVERVIEW */}
      <Section id="em-overview" title="9. Employee Management — overview">
        <P>Employee Management is an add-on that turns Rudrans into your one-stop IT lifecycle tool: provisioning, credentials, hardware, offboarding.</P>
        <Sub title="9.1 Activation">
          <Steps items={[
            <>During trial: everything is unlocked automatically.</>,
            <>After trial: subscribe to the EM add-on (₹ 8,500 / month, unlimited users) in Admin Portal → Subscription → Add-ons.</>,
            <>Or buy a standalone EM-only plan if you don't need monitoring.</>,
          ]} />
        </Sub>
      </Section>

      {/* 10. INTEGRATIONS */}
      <Section id="em-integrations" title="10. Microsoft 365 / Google Workspace connect">
        <P>Connect your directory once. Users, groups, teams, shared mailboxes auto-sync.</P>
        <Sub title="10.1 Microsoft 365">
          <Steps items={[
            <>Open <strong>Employees → Integrations</strong>.</>,
            <>Click <strong>Grant admin consent</strong>. Your global admin signs into Microsoft and approves the required permissions.</>,
            <>Required Graph application permissions: <code>User.ReadWrite.All</code>, <code>Group.ReadWrite.All</code>, <code>GroupMember.ReadWrite.All</code>, <code>Directory.ReadWrite.All</code>, <code>Organization.Read.All</code>, <code>Domain.Read.All</code>, <code>Mail.Send</code>.</>,
            <>After consent, you're redirected back. Status flips to "active". First sync runs automatically.</>,
          ]} />
          <Shot caption="M365 grant admin consent button + tenant info" />
        </Sub>
        <Sub title="10.2 Google Workspace">
          <Steps items={[
            <>Click <strong>Sign in with Google</strong>. Use your Workspace super-admin account.</>,
            <>Google's consent screen lists Directory + Gmail.Send scopes. Click Allow.</>,
            <>Status flips to active. First sync starts.</>,
          ]} />
          <Callout kind="info" title="One-click connect">
            We've replaced the old service-account / Domain-Wide-Delegation setup. Now it's a simple OAuth flow — no Google Admin Console steps required.
          </Callout>
        </Sub>
        <Sub title="10.3 Sender mailbox">
          <P>Credential delivery + offboarding emails go FROM your own mailbox (e.g. <code>hr@yourcompany.com</code>) instead of Rudrans. Set this once under <strong>Employees → Integrations → Sender Mailbox</strong>.</P>
        </Sub>
        <Sub title="10.4 Disconnect">
          <P>The <strong>Disconnect</strong> button wipes every synced user, group, and team membership for that provider and clears the saved tokens. Reconnecting + syncing repopulates everything fresh.</P>
        </Sub>
      </Section>

      {/* 11. EMPLOYEES */}
      <Section id="em-employees" title="11. Add employees">
        <Sub title="11.1 List view">
          <P>Employees page shows directory + non-directory employees together. Filter by status, department, manager.</P>
        </Sub>
        <Sub title="11.2 Create a new M365 user">
          <Steps items={[
            <>Click <strong>+ Add Microsoft 365 user</strong>.</>,
            <>Fill personal email, full name, designation, department, manager, joining date, license SKU.</>,
            <>Click <strong>Provision</strong>. Rudrans creates the M365 mailbox, assigns the license, generates a temp password, and emails the new hire's personal address with welcome details.</>,
          ]} />
        </Sub>
        <Sub title="11.3 Edit / offboard">
          <P>Each row's three-dot menu: Edit details · Reset password · Move to Offboarding.</P>
        </Sub>
      </Section>

      {/* 12. GROUPS */}
      <Section id="em-groups" title="12. Groups & Teams">
        <P>Manage Microsoft 365 / Google groups + Teams memberships from one screen.</P>
        <Bullets items={[
          'Search and filter by provider (M365 / Google) or group type (Security / Distribution / Team / Channel)',
          'Click "Manage group memberships" on any user to add/remove from many groups in one diff',
          'Read-only groups (on-prem AD synced / dynamic / role-assigned) show "Read-only" badge — disabled checkbox',
          'Changes apply via Microsoft Graph / Google Admin SDK and reflect within seconds',
        ]} />
      </Section>

      {/* 13. MANAGERS */}
      <Section id="em-managers" title="13. Managers">
        <Bullets items={[
          'Set each employee\'s reporting manager.',
          'Manager hierarchy used by credential-request flow (request → manager approve → IT provision).',
          'Org-chart view shows reporting structure.',
        ]} />
      </Section>

      {/* 14. CREDENTIALS */}
      <Section id="em-credentials" title="14. Credentials Vault">
        <P>Encrypted password storage with a self-service request workflow.</P>
        <Sub title="14.1 Add credentials">
          <Steps items={[
            <>Open <strong>Credentials Vault</strong> → <strong>+ New credential</strong>.</>,
            <>Platform name, login URL, username, password, notes.</>,
            <>Password is encrypted at rest using <code>pgp_sym_encrypt</code>. Plain text never leaves the database except when sent.</>,
          ]} />
        </Sub>
        <Sub title="14.2 Send directly to an employee">
          <Steps items={[
            <>From the vault row → <strong>Send to user</strong> → pick employee.</>,
            <>Rudrans decrypts inside an edge function, emails the employee, logs the send to <code>credential_assignments</code>.</>,
            <>Email goes from your configured Sender Mailbox.</>,
          ]} />
        </Sub>
        <Sub title="14.3 Public request form">
          <P>Each org gets a unique URL like <code>https://ems.rudrans.com/r/credentials-request</code>. Share with employees. They:</P>
          <Steps items={[
            <>Open the form, enter work email — only domains matching a connected directory integration are accepted.</>,
            <>OTP arrives to the work email. Verify.</>,
            <>Pick platforms needed + add a custom note → Submit.</>,
            <>Manager (or IT if no manager) receives an HMAC-signed magic link to Approve / Reject.</>,
            <>On approval, IT receives a magic link to dispatch credentials.</>,
            <>Employee gets their creds in their inbox.</>,
          ]} />
          <Callout kind="info">
            Every step writes to the <strong>credential_requests</strong> + <strong>credential_assignments</strong> tables. The full audit trail is visible in the Requests tab.
          </Callout>
        </Sub>
        <Sub title="14.4 Bulk import / export">
          <P>CSV upload supports columns: platform_name, login_url, username, password, notes. Each row encrypted on the server.</P>
        </Sub>
      </Section>

      {/* 15. HARDWARE */}
      <Section id="em-hardware" title="15. IT Hardware Inventory">
        <P>Track every laptop, monitor, phone, peripheral. Assignment + value tracking.</P>
        <Sub title="15.1 Inventory tab">
          <Bullets items={[
            'Columns: Tag/Serial, Type, Brand · Model, Spec, Assigned to, Join date, Exit date, History count, Price, Status',
            'Status: in_stock / assigned / retired / lost / rma',
            'Click N× in History column → drawer with every past + current assignment',
            'Search + filter (status, type) + paginated (50 per page)',
          ]} />
          <Shot caption="Hardware inventory table with assignment + join/exit + history" />
        </Sub>
        <Sub title="15.2 Add / edit / assign">
          <Steps items={[
            <>Click <strong>+ Add device</strong>: serial, tag, type, brand, model, spec, purchase price, currency.</>,
            <>From any row: <strong>Assign</strong> → pick employee → save. Status flips to assigned, history row appended.</>,
            <>Re-assign or unassign anytime.</>,
          ]} />
        </Sub>
        <Sub title="15.3 CSV upload">
          <P>Upload a CSV with serial/tag/type/etc. CSV import auto-normalizes status (Active / In Use / Available / etc.) and type (MacBook / Notebook / iPad / etc.) to the DB enum.</P>
        </Sub>
      </Section>

      {/* 16. OFFBOARDING */}
      <Section id="em-offboarding" title="16. Offboarding pipeline">
        <P>4 distinct stages, each with its own action button. No emails go out until Stage 4 (NOC).</P>
        <Sub title="Stage flow">
          <KV k="Stage 1: Creds review" v="Email to IT with full list of credentials issued to the employee. IT verifies and clicks Revoke sign-in." />
          <KV k="Stage 2: Revoke credentials" v="M365 / Google sign-in revoked. IT advances to Stage 3 (no email sent this step)." />
          <KV k="Stage 3: Device handover" v="Auto-fetched credentials checklist (mark each revoked) + assigned devices auto-listed + IT remark. Required: IT remark field." />
          <KV k="Stage 4: Completed" v="NOC issued to HR + Accounts. Devices auto-unassigned. Employee lwd stamped. Status → offboarded." />
        </Sub>
        <Sub title="Tabs">
          <Bullets items={[
            'Active pipeline — kanban with 4 columns',
            'History — every past offboarding, searchable by year / employee / reason',
            'Dashboard — monthly bar chart + top reasons + average days to close',
          ]} />
        </Sub>
        <Sub title="Default recipients">
          <P>Set IT / HR / Accounts mailing lists once in the Default Recipients card at the top of the page. Every new offboarding pre-fills these.</P>
        </Sub>
      </Section>

      {/* 17. ADMIN PORTAL */}
      <Section id="admin-portal" title="17. Admin Portal">
        <P>Reachable via <strong>Admin Portal</strong> in the sidebar (<code className="text-emerald-300">/admin-portal</code>). Tabs:</P>
        <Sub title="Organization">
          <Bullets items={[
            'Edit org name, contact person, GST, PAN, address, country, phone',
            'License key (copy)',
            'Current plan + seat usage + trial expiry',
            'Billed-by panel (Rudrans direct / channel partner)',
            'Invoice history',
          ]} />
        </Sub>
        <Sub title="Subscription">
          <Bullets items={[
            'Current plan card (price + seat count + features)',
            '"Compare & Upgrade" expands all available plans',
            'Add-on toggles (Employee Management Unlimited)',
            'Upgrade request creates a pending request — Rudrans super-admin approves',
          ]} />
        </Sub>
        <Sub title="Users">
          <Bullets items={[
            'Invite user with role: Viewer / Manager / Org Admin',
            'Edit role / status',
            'Reset their password (sends an email)',
            'Revoke or delete the user',
          ]} />
        </Sub>
        <Sub title="Departments / Settings">
          <Bullets items={[
            'Create / rename / delete departments (used by employees + filters)',
            'Email notifications, AI alerts, screenshot/video toggles, data retention',
          ]} />
        </Sub>
      </Section>

      {/* 18. SUBSCRIPTION */}
      <Section id="subscription" title="18. Subscription & billing">
        <Sub title="Plans">
          <Bullets items={[
            <><strong>Starter</strong> — ₹ 53,999 / month · 5 agents · Productivity reports</>,
            <><strong>Professional</strong> — ₹ 2,10,000 / year · 25 agents · Reports + Screenshots + Video + AI alerts</>,
            <><strong>Employee Management Unlimited</strong> — ₹ 8,500 / month · unlimited users · EM suite only</>,
            <><strong>Enterprise</strong> — Custom · 100+ agents · Everything + DLP + dedicated support</>,
          ]} />
        </Sub>
        <Sub title="Add-ons">
          <Bullets items={[
            'Employee Management — ₹ 8,500 / month (added on top of any plan)',
            'DLP USB + Email — included in Enterprise; available as add-on otherwise',
          ]} />
        </Sub>
        <Sub title="Billing">
          <Bullets items={[
            'Razorpay (Indian customers, INR)',
            'Direct bank transfer (Indian customers; mark paid in invoice)',
            'Channel partner billing — your partner invoices you, 20% commission to them',
          ]} />
        </Sub>
      </Section>

      {/* 19. TROUBLESHOOTING */}
      <Section id="troubleshooting" title="19. Troubleshooting">
        <Sub title="Agent shows offline despite computer being on">
          <Bullets items={[
            'Check the agent system tray icon — green = online, gray = offline.',
            'Reboot the laptop.',
            'Reinstall using fresh license key from Agent Setup page.',
          ]} />
        </Sub>
        <Sub title="OAuth login redirects to localhost">
          <Bullets items={[
            'You\'re probably testing on localhost in dev. Use https://ems.rudrans.com in production.',
            'If you see this on production: clear browser cache, try incognito.',
          ]} />
        </Sub>
        <Sub title="Group membership change fails with 403">
          <Bullets items={[
            'Group is likely synced from on-prem AD (read-only in cloud) — manage in Active Directory Users & Computers.',
            'Or it\'s a dynamic / role-assigned group. The UI now shows a "Read-only" badge with the reason.',
          ]} />
        </Sub>
        <Sub title="Hardware CSV upload errors">
          <P>Status / type values are auto-normalized — "Active", "In Use", "MacBook", etc. all map correctly. If you still get errors, check the response body for the exact column that failed.</P>
        </Sub>
        <Sub title="Still stuck?">
          <P>Email <code>support@rudrans.com</code> with the screenshot + the URL bar. Response within one business day.</P>
        </Sub>
      </Section>
    </DocsLayout>
  );
}
