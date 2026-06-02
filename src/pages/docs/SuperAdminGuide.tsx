import DocsLayout, { Section, Sub, P, Steps, Bullets, Callout, Shot, KV, Code } from './DocsLayout';

const sections = [
  { id: 'access',         label: '1. Access' },
  { id: 'dashboard',      label: '2. Admin Dashboard' },
  { id: 'customers',      label: '3. Customers' },
  { id: 'partners',       label: '4. Partners' },
  { id: 'licenses',       label: '5. Licenses' },
  { id: 'invoices',       label: '6. Invoices' },
  { id: 'plans',          label: '7. Plans' },
  { id: 'integrations',   label: '8. Integrations' },
  { id: 'dlp',            label: '9. DLP cross-tenant' },
  { id: 'audit',          label: '10. Audit log' },
  { id: 'storage',        label: '11. Storage' },
  { id: 'admin-users',    label: '12. Admin users' },
  { id: 'docs',           label: '13. Internal docs' },
  { id: 'sql-console',    label: '14. SQL & Postgres ops' },
  { id: 'edge-functions', label: '15. Edge functions' },
  { id: 'deploys',        label: '16. Deploys' },
];

export default function SuperAdminGuide() {
  return (
    <DocsLayout
      title="Super Admin Guide"
      subtitle="Internal documentation for Rudrans platform operators — how every part of the super-admin portal works."
      sections={sections}
      accent="violet"
    >
      <Section id="access" title="1. Access">
        <P>Super-admin is the platform-wide role that sees every customer + partner.</P>
        <Sub title="Login routes">
          <Bullets items={[
            <><code className="text-violet-300">/super</code> — direct super-admin login (purple branded), strict role check, kicks you out if you're not super_admin.</>,
            <>OR if you also belong to a customer org: log in normally, then click <strong>Super Admin</strong> in the sidebar.</>,
          ]} />
        </Sub>
        <Sub title="Role grant">
          <Bullets items={[
            <>Bootstrap: the very first super-admin is set manually via SQL: <code>INSERT INTO app_users(user_id, app_role) VALUES (...)</code>.</>,
            <>After that: existing super-admins invite others from <code>/admin/users</code>.</>,
          ]} />
        </Sub>
        <Callout kind="warn" title="Self-protection">
          You cannot revoke / disable / delete your own super-admin account. The last remaining super-admin is also protected — invite a successor before stepping down.
        </Callout>
      </Section>

      <Section id="dashboard" title="2. Admin Dashboard">
        <P>Landing screen at <code className="text-violet-300">/admin/dashboard</code>.</P>
        <Bullets items={[
          'Total partners (approved + pending count badge)',
          'Total customers (active / trial / suspended split)',
          'Active licenses + MRR estimate',
          'Pending invoices',
          'DLP alerts in the last 24 h (cross-tenant)',
          'Recent signups + recent invoice activity',
        ]} />
        <Shot caption="Admin Dashboard with KPIs + recent activity feed" />
      </Section>

      <Section id="customers" title="3. Customers">
        <P>Path: <code className="text-violet-300">/admin/customers</code>. Lists every organisation on the platform.</P>
        <Sub title="3.1 List view">
          <Bullets items={[
            'Filter: All / Direct (no partner) / Via Partner',
            'Search by name',
            'Columns: Organisation, Partner, Status (trial/active/suspended/canceled), Add-ons chips (EM / DLP), Agents, Licenses, Created',
            'Per-row actions: View · Resend Invite · Suspend / Re-activate · Delete',
          ]} />
        </Sub>
        <Sub title="3.2 Customer detail page">
          <Bullets items={[
            'Profile (name, GST, PAN, address, contact, phone) — editable',
            'Licenses Issued (with extend / activate-pending actions)',
            'Upgrade Requests (pending plan-change requests with Approve & switch / Reject)',
            'Subscription & Add-ons (status flip · trial extend +7d/+14d/+30d/custom · EM toggle)',
            'Monitoring Features (per-feature 3-state: On / Off / Plan default)',
            'Agents enrolled',
            'Users (org_members) with reset-password button',
            'Audit slice for this customer',
          ]} />
          <Shot caption="Customer detail page with all six panels" />
        </Sub>
        <Sub title="3.3 Approving upgrade requests">
          <P>When a customer clicks "Select & Upgrade" in their portal, a row lands here. Click <strong>Approve &amp; switch</strong> →</P>
          <Steps items={[
            <>Active license's <code>plan_id</code> flips to the requested plan.</>,
            <><code>seat_count</code> updates to match the new plan.</>,
            <>Audit row written.</>,
            <>Customer's portal dashboard reflects the new plan immediately.</>,
          ]} />
        </Sub>
      </Section>

      <Section id="partners" title="4. Partners">
        <P>Path: <code className="text-violet-300">/admin/partners</code>.</P>
        <Sub title="4.1 Pending applications">
          <Bullets items={[
            'New /partner-signup submissions land here with status="pending".',
            'Review: legal entity, contact, GST, expected volume, sales pitch.',
            'Approve → sends magic-link invite + creates app_users row with app_role="partner".',
            'Reject → marks status="rejected" with optional reason note.',
          ]} />
        </Sub>
        <Sub title="4.2 Approved partners">
          <Bullets items={[
            'Click row → detail page',
            'Edit profile (legal name, GST, PAN, address, support email)',
            'Set commission rate (default 20%, overridable per-partner)',
            'See their customers + MRR routed through them',
            'Generate next monthly Rudrans-to-partner invoice',
          ]} />
        </Sub>
      </Section>

      <Section id="licenses" title="5. Licenses">
        <P>Path: <code className="text-violet-300">/admin/licenses</code>.</P>
        <Bullets items={[
          'Every license issued across the platform.',
          'Filter by status (active / suspended / expired / revoked / pending_payment).',
          'Actions: Activate (after partner confirms payment received), Extend renewal (+N periods OR custom date), Suspend, Revoke.',
          'Each license belongs to an organisation and points to a plan.',
        ]} />
      </Section>

      <Section id="invoices" title="6. Invoices">
        <P>Path: <code className="text-violet-300">/admin/invoices</code>.</P>
        <Sub title="6.1 Invoice list">
          <Bullets items={[
            'Customer invoices (raised by Rudrans or by partners on behalf of customers).',
            'Status: pending / paid / overdue / cancelled.',
            'Search by invoice number, org name, partner.',
          ]} />
        </Sub>
        <Sub title="6.2 Manual operations">
          <Bullets items={[
            'Mark as paid (admin override for direct-bank-transfer customers).',
            'Resend invoice email.',
            'Download PDF.',
            'Cancel / write off.',
          ]} />
        </Sub>
      </Section>

      <Section id="plans" title="7. Plans">
        <P>Path: <code className="text-violet-300">/admin/plans</code>. Edit the plans every customer sees in their /admin-portal → Subscription tab.</P>
        <Bullets items={[
          'Plan code (e.g. starter-5, growth-25, scale-100, em-unlimited)',
          'Display name + description',
          'Customer price (price_inr / price_usd) — the MRP',
          'Partner price (partner_price_inr) — the cost to partners',
          'Seat count + billing cycle (monthly / yearly)',
          'Features included (screenshots, video_recording, ai_alerts, dlp, productivity_reports)',
          'EM add-on price (em_addon_price_inr) — set per-plan',
        ]} />
        <Callout kind="info">
          Plans seeded by migration 0013 + 0045. Adding a new plan here writes to the <code>plans</code> table; existing customers stay on their current plan_id until they explicitly upgrade.
        </Callout>
      </Section>

      <Section id="integrations" title="8. Integrations">
        <P>Path: <code className="text-violet-300">/admin/integrations</code>. Master list of every API key + service credential the platform uses. Editable from the UI — no redeploy.</P>
        <Sub title="Categories">
          <Bullets items={[
            <><strong>Auth & OAuth</strong> — Google + Microsoft OAuth client IDs and secrets, "Sync to Supabase Auth" button to push to Cloud Auth config.</>,
            <><strong>Email</strong> — Microsoft tenant + client + secret for sending platform mail (Rudrans mailbox).</>,
            <><strong>AI</strong> — Anthropic API key (Claude Haiku 4.5 primary), OpenAI key (GPT-4o-mini fallback).</>,
            <><strong>Billing</strong> — Razorpay key id + secret, GST lookup API key.</>,
            <><strong>Employee Management</strong> — Multi-tenant directory app client id + secret, Google service-account email + private key + client id.</>,
          ]} />
        </Sub>
        <Sub title="Edit flow">
          <Steps items={[
            <>Click <strong>Edit</strong> on any row.</>,
            <>Update the value. Click <strong>Save</strong>. Cached for 30 seconds inside edge functions.</>,
            <>For OAuth Google/Microsoft: click <strong>Sync to Supabase Auth</strong> to PATCH the Cloud Auth config via Management API (uses stored SUPABASE_MANAGEMENT_TOKEN).</>,
          ]} />
        </Sub>
      </Section>

      <Section id="dlp" title="9. DLP cross-tenant">
        <P>Path: <code className="text-violet-300">/admin/dlp</code>.</P>
        <Bullets items={[
          'Every DLP event from every customer, real-time.',
          'Filter by tenant, severity, type (usb / email).',
          'Read-only (customers manage their own alerts in their tenant).',
          'Useful for spotting threat patterns across the platform.',
        ]} />
      </Section>

      <Section id="audit" title="10. Audit log">
        <P>Path: <code className="text-violet-300">/admin/audit</code>. The platform-wide audit trail.</P>
        <Bullets items={[
          'Every super-admin action (customer suspended, plan changed, license extended, etc.)',
          'Login failures, brute-force lockouts, permission_denied events (from migration 0057)',
          'Filter by action type, actor, IP, time range',
          'Export CSV',
        ]} />
      </Section>

      <Section id="storage" title="11. Storage">
        <P>Path: <code className="text-violet-300">/admin/storage</code>. Supabase Storage bucket stats + cleanup.</P>
        <Bullets items={[
          'Screenshots bucket — total objects + size per org',
          'Videos bucket — same',
          'Releases bucket — public, hosts agent installers + signed update manifest',
          'Manual cleanup actions (e.g. purge older than retention)',
        ]} />
      </Section>

      <Section id="admin-users" title="12. Admin users">
        <P>Path: <code className="text-violet-300">/admin/users</code>. Manage who else has super-admin access.</P>
        <Bullets items={[
          'Invite admin — sends magic link, pre-stages super_admin role',
          'Reset PW — send reset email',
          'Disable — block sign-in (account preserved)',
          'Enable — re-enable a disabled account',
          'Revoke — drop super_admin role only (account becomes a normal user)',
          'Delete — fully remove the auth.users row',
        ]} />
        <Callout kind="warn">
          Self-actions are blocked: cannot disable / revoke / delete your own account. The last remaining super_admin also cannot be revoked or deleted.
        </Callout>
      </Section>

      <Section id="docs" title="13. Internal docs (this page)">
        <P>The Super Admin Guide + Tech Architecture pages are reachable from <code className="text-violet-300">/admin/docs/super-admin</code> and <code className="text-violet-300">/admin/docs/architecture</code>. Both require super_admin role.</P>
      </Section>

      <Section id="sql-console" title="14. SQL & Postgres ops">
        <P>For raw DB tasks (cron jobs, schema changes, one-off backfills) you have two paths:</P>
        <Sub title="Cloud (production)">
          <Code>{`https://supabase.com/dashboard/project/ttjazaxjhzvrzhptrpmd/sql/new`}</Code>
        </Sub>
        <Sub title="Self-hosted (api-ems.wellnessextract.com)">
          <Code>{`ssh -i agent.pem ubuntu@54.241.176.28
sudo docker exec -it supabase-db psql -U postgres -d postgres`}</Code>
        </Sub>
        <Sub title="Pg_cron jobs already wired">
          <Bullets items={[
            <><code>sweep_offline_agents</code> — every minute, marks agents silent &gt; 150 s as offline</>,
            <><code>directory_sync_cron</code> — every 5 min, calls directory-sync edge function for every connected tenant</>,
            <><code>vault_seed_cron</code> — periodic cred-vault dataset refresh</>,
            <><code>retention_purge</code> — daily, deletes screenshots / videos older than per-org retention</>,
          ]} />
        </Sub>
      </Section>

      <Section id="edge-functions" title="15. Edge functions">
        <P>The platform runs 40+ Supabase Edge Functions (Deno runtime). Inspect at:</P>
        <Code>{`https://supabase.com/dashboard/project/ttjazaxjhzvrzhptrpmd/functions`}</Code>
        <Sub title="Key categories">
          <Bullets items={[
            <><strong>Auth</strong>: send-auth-email, send-phone-otp, verify-phone-otp</>,
            <><strong>Signup / billing</strong>: start-trial-signup, razorpay-create-order, razorpay-start-signup, razorpay-webhook</>,
            <><strong>Admin</strong>: admin-invite-customer-owner, admin-invite-partner, approve-partner, admin-users-manage</>,
            <><strong>Org settings</strong>: org-settings-save, org-subscription-update, sync-oauth-providers</>,
            <><strong>Agent</strong>: enroll-agent, agent-settings, validate-license, ingest, upload-screenshot, upload-video</>,
            <><strong>DLP</strong>: dlp-ingest, dlp-alert-email</>,
            <><strong>Employee Management</strong>: provision-employee, employee-save, delete-employee, manager-assign-reports, group-membership-mutate, directory-sync, directory-disconnect, oauth-m365-callback, oauth-google-callback, google-connect, m365-tenant-info</>,
            <><strong>Credentials</strong>: cred-save, cred-send-direct, cred-bulk-import, cred-request-start, cred-request-submit, cred-request-decision</>,
            <><strong>Hardware</strong>: asset-save, asset-assign, asset-bulk-import</>,
            <><strong>Offboarding</strong>: offboarding (handles start / revoke / advance_to_devices / complete)</>,
            <><strong>Invoices</strong>: invoice-save, invoice-bulk-import, invoice-connector-save, invoice-sync</>,
          ]} />
        </Sub>
      </Section>

      <Section id="deploys" title="16. Deploys">
        <Sub title="Frontend">
          <Code>{`# Build
npm run build         # outputs to ./out

# Deploy to api-ems.wellnessextract.com (self-hosted)
rsync -avz out/ ubuntu@54.241.176.28:/tmp/rudrans-app-deploy/
ssh ubuntu@54.241.176.28 'sudo rsync -a --delete /tmp/rudrans-app-deploy/ /var/www/rudrans-app/'

# Supabase Cloud frontend lives at ems.wellnessextract.com (same bundle, different .env)`}</Code>
        </Sub>
        <Sub title="Edge functions">
          <Code>{`# Cloud
SUPABASE_ACCESS_TOKEN=sbp_... npx supabase functions deploy <name>

# Self-hosted (file-mode)
scp supabase/functions/<name>/index.ts ubuntu@54.241.176.28:/tmp/
ssh ubuntu@54.241.176.28 'sudo cp /tmp/index.ts /opt/rudrans/supabase/docker/volumes/functions/<name>/index.ts'
ssh ubuntu@54.241.176.28 'sudo docker compose -f /opt/rudrans/supabase/docker/docker-compose.yml restart functions'`}</Code>
        </Sub>
        <Sub title="Migrations">
          <Code>{`# Cloud
SUPABASE_ACCESS_TOKEN=sbp_... npx supabase db push --linked

# Self-hosted
scp supabase/migrations/00XX_*.sql ubuntu@54.241.176.28:/tmp/
ssh ubuntu@54.241.176.28 \\
  'sudo docker cp /tmp/00XX_*.sql supabase-db:/tmp/ && \\
   sudo docker exec supabase-db psql -U postgres -d postgres -f /tmp/00XX_*.sql'`}</Code>
        </Sub>
      </Section>
    </DocsLayout>
  );
}
