import DocsLayout, { Section, Sub, P, Bullets, Code, Callout, KV } from './DocsLayout';

const sections = [
  { id: 'stack',          label: '1. Tech stack' },
  { id: 'frontend',       label: '2. Frontend' },
  { id: 'backend',        label: '3. Backend (Supabase)' },
  { id: 'agent',          label: '4. Desktop agent (Tauri)' },
  { id: 'routes',         label: '5. Routes (frontend)' },
  { id: 'edge-functions', label: '6. Edge functions' },
  { id: 'schema',         label: '7. Database schema' },
  { id: 'rls',            label: '8. RLS / multi-tenancy' },
  { id: 'auth',           label: '9. Auth flows' },
  { id: 'oauth-em',       label: '10. M365 / Google OAuth' },
  { id: 'email',          label: '11. Email delivery' },
  { id: 'storage',        label: '12. Storage / encryption' },
  { id: 'deployment',     label: '13. Deployment topology' },
  { id: 'security',       label: '14. Security controls' },
  { id: 'cron',           label: '15. Scheduled jobs' },
];

export default function Architecture() {
  return (
    <DocsLayout
      title="Backend / Frontend Architecture"
      subtitle="Internal engineering reference for the Rudrans platform."
      sections={sections}
      accent="cyan"
    >
      <Section id="stack" title="1. Tech stack overview">
        <KV k="Frontend" v="React 19 + Vite (Rolldown) + TypeScript + Tailwind CSS + React Router 7" />
        <KV k="Backend" v="Supabase: Postgres 15 + PostgREST + GoTrue (Auth) + Edge Functions (Deno)" />
        <KV k="Desktop agent" v="Tauri 2 (Rust + WebView) with notify-rs filesystem watcher + uiautomation crate (Windows) / osascript (macOS)" />
        <KV k="AI" v="Anthropic Claude Haiku 4.5 (primary classifier), OpenAI GPT-4o-mini (fallback)" />
        <KV k="Hosting" v="Two parallel stacks: Supabase Cloud (ttjazaxjhzvrzhptrpmd) AND self-hosted Supabase on EC2 (api-ems.rudrans.com)" />
        <KV k="Reverse proxy" v="nginx 1.24 on Ubuntu 22.04" />
        <KV k="Builds" v="GitHub Actions for agent multi-platform releases (Windows, macOS arm/intel, Linux)" />
      </Section>

      <Section id="frontend" title="2. Frontend">
        <Sub title="Build">
          <Bullets items={[
            'Vite 8 with Rolldown for fast bundling',
            'Route-level code splitting via React.lazy() — initial bundle ~140 KB gzipped',
            'manualChunks splits react / router / supabase / i18n as foundational vendors; everything else lazy-loaded',
            'Sourcemaps disabled in production',
          ]} />
        </Sub>
        <Sub title="Theme">
          <Bullets items={[
            'Tailwind CSS with custom dark-* + zinc palette',
            'Linear/Vercel-inspired monochrome design with violet accent #5e6ad2 on auth pages',
            'Plus Jakarta Sans headings; Inter body',
            'Scoped to .dashboard-shell so the marketing landing page stays dark/glossy',
          ]} />
        </Sub>
        <Sub title="State">
          <Bullets items={[
            'AuthContext provides session + organization + signIn helpers',
            'Per-page useState; complex pages use useReducer-style patterns',
            'No global state library — Supabase realtime + manual refetch covers the live data',
          ]} />
        </Sub>
      </Section>

      <Section id="backend" title="3. Backend (Supabase)">
        <Sub title="Postgres">
          <Bullets items={[
            '57 numbered migrations under /supabase/migrations',
            'Multi-tenant by org_id on every row',
            'RLS enabled on every public table; service-role keys only inside edge functions',
            'Indexes on (org_id, created_at) hot paths',
            'pg_cron for scheduled jobs',
            'pgcrypto for password / token encryption (pgp_sym_encrypt)',
          ]} />
        </Sub>
        <Sub title="PostgREST (auto-REST)">
          <Bullets items={[
            'Every public table exposed as REST endpoint at /rest/v1/<table>',
            'RLS-enforced; views also enforce RLS thanks to security_invoker=true (migration 0051)',
            'Range header pagination',
            'Realtime via WebSocket: pg_logical replication → Realtime server',
          ]} />
        </Sub>
        <Sub title="GoTrue (Auth)">
          <Bullets items={[
            'Email + password',
            'Magic-link / OTP for credential-request flow',
            'External providers: Google (OAuth 2.0), Microsoft Entra (multi-tenant)',
            'JWT tokens (HS256 legacy + RS256 asymmetric via JWKS)',
            'banned_until used for brute-force lockout (10 failed logins in 15 min → 30 min ban)',
          ]} />
        </Sub>
        <Sub title="Edge Functions">
          <Bullets items={[
            'Deno runtime',
            'Each function ~100-400 LoC, single-purpose',
            '_shared/ folder for cross-fn helpers (crypto, integrations, graph, google, auth-org)',
            'service-role key passed by env; never exposed to browser',
          ]} />
        </Sub>
      </Section>

      <Section id="agent" title="4. Desktop agent (Tauri)">
        <Sub title="Crate layout">
          <Code>{`agent/
├── src/                  # React UI for tray + onboarding flow
├── src-tauri/
│   ├── Cargo.toml        # crate name: rudrans-agent
│   ├── src/
│   │   ├── main.rs       # bootstraps watchdog + main loop
│   │   ├── watchdog.rs   # sibling guardian process, respawns on kill
│   │   ├── dlp.rs        # USB + email composer monitoring
│   │   ├── browser_url.rs# Chrome/Edge/Safari URL extraction (UIA on Win, osascript on Mac)
│   │   ├── ingest.rs     # batches + uploads activity rows to /functions/v1/ingest
│   │   └── ...
│   ├── tauri.conf.json   # identifier: com.rudrans.agent
│   └── gen/schemas/      # signed updater manifest
└── ...`}</Code>
        </Sub>
        <Sub title="Capabilities">
          <Bullets items={[
            'Active window + page title + browser URL polling every 5 s',
            'Screenshots every 5 min (configurable)',
            'Periodic system metrics (CPU/RAM/disk/network)',
            'USB filesystem watcher → AI classification → DLP event',
            'Email compose tracker → personal-mail attachment detection',
            'Auto-updater: minisign-signed manifest at /storage/v1/object/public/releases/latest.json',
            'Watchdog: sibling Tauri process, respawns main agent within 5 s of any kill',
            'Server-controlled DLP enable/disable (per-agent agent_settings.dlp_enabled)',
          ]} />
        </Sub>
      </Section>

      <Section id="routes" title="5. Frontend routes">
        <Sub title="Public">
          <Code>{`/                        Marketing landing
/login                   Customer login
/signup                  Customer signup
/signup-success          Post-signup confirmation
/complete-signup         Org details step
/post-login              Role-aware router
/reset-password          Password reset landing
/partner-signup          Public partner application
/partner/login           Partner-only login
/super                   Internal super-admin login (unlinked)
/r/credentials-request   Public credential-request form (HMAC-gated)
/r/decision              Manager / IT approve/reject landing
/docs/user-guide         This guide
/docs/partner-guide      Partner guide`}</Code>
        </Sub>
        <Sub title="Customer (RequireAuth)">
          <Code>{`/dashboard               Real-time KPIs
/monitoring              Live agent feed
/agents                  Agent list
/agents/:agentId         Per-agent timeline + screenshots + system health
/setup                   Agent install download
/alerts                  Unresolved + resolved alerts
/dlp                     DLP events
/system-health           Cross-agent health
/performance-reports     Aggregated productivity
/reports                 Exports
/employees               Employee directory
/employees/new           Add employee
/employees/new/m365      Provision M365 user wizard
/employees/groups        Groups & Teams manager
/employees/managers      Reporting hierarchy
/employees/credentials   Vault + requests + invoices + access
/employees/hardware      IT hardware inventory + dashboard + history
/employees/offboarding   Pipeline + history + dashboard
/employees/integrations  M365 / Google connect + sender mailbox
/subscription            Self-service subscription (org owner)
/admin-portal            Org settings tabs (Organization · Subscription · Users · Departments · Settings)`}</Code>
        </Sub>
        <Sub title="Super admin (RequireSuperAdmin)">
          <Code>{`/admin/dashboard
/admin/partners
/admin/partners/:partnerId
/admin/customers
/admin/customers/:customerId
/admin/licenses
/admin/invoices
/admin/plans
/admin/dlp
/admin/audit
/admin/integrations
/admin/storage
/admin/users             # admin team management
/admin/docs/super-admin  # this guide
/admin/docs/architecture # tech architecture`}</Code>
        </Sub>
        <Sub title="Partner (RequirePartner)">
          <Code>{`/partner/dashboard
/partner/customers
/partner/licenses
/partner/invoices
/partner/profile`}</Code>
        </Sub>
      </Section>

      <Section id="edge-functions" title="6. Edge functions">
        <P>Full list under <code>/supabase/functions/</code>. Naming convention is <code>kebab-case</code>. Each has an <code>index.ts</code> entry-point.</P>
        <Sub title="Auth & signup">
          <Bullets items={[
            'send-auth-email — custom email hook (uses API_EXTERNAL_URL for self-hosted)',
            'send-phone-otp / verify-phone-otp',
            'start-trial-signup',
            'razorpay-create-order / razorpay-start-signup / razorpay-webhook',
            'admin-invite-customer-owner / admin-invite-partner / approve-partner',
            'admin-users-manage (super-admin invite / revoke / disable / delete)',
            'sync-oauth-providers (PATCH Supabase Auth config via Management API)',
          ]} />
        </Sub>
        <Sub title="Agent telemetry">
          <Bullets items={[
            'enroll-agent · agent-settings · validate-license',
            'ingest (activity batches) · upload-screenshot · upload-video',
            'dlp-ingest (AI classification) · dlp-alert-email (Graph SendMail)',
          ]} />
        </Sub>
        <Sub title="Employee Management">
          <Bullets items={[
            'oauth-m365-callback · oauth-google-callback · google-connect',
            'directory-sync · directory-disconnect',
            'm365-tenant-info',
            'provision-employee · employee-save · delete-employee · manager-assign-reports',
            'group-membership-mutate',
            'cred-save · cred-send-direct · cred-bulk-import',
            'cred-request-start · cred-request-submit · cred-request-decision',
            'asset-save · asset-assign · asset-bulk-import',
            'offboarding (handles start / revoke / advance_to_devices / complete)',
          ]} />
        </Sub>
        <Sub title="Org / billing">
          <Bullets items={[
            'org-settings-save (IT/HR/Accounts recipient lists)',
            'org-subscription-update (EM toggle)',
            'invoice-save · invoice-bulk-import · invoice-connector-save · invoice-sync',
            'gst-lookup (GSTIN decode)',
          ]} />
        </Sub>
        <Sub title="Shared helpers (_shared/)">
          <Bullets items={[
            <><code>cors.ts</code> — CORS headers</>,
            <><code>crypto.ts</code> — encrypt/decrypt + adminClient(); KeyName = DIRECTORY_TOKEN_ENC_KEY | CRED_VAULT_ENC_KEY</>,
            <><code>integrations.ts</code> — cached reads from public.integrations</>,
            <><code>graph.ts</code> — Microsoft Graph token mint + paged fetch (per-org)</>,
            <><code>google.ts</code> — Google OAuth refresh-token mint + Admin SDK helpers</>,
            <><code>graph-email.ts</code> — sendGraphEmail with M365 → Gmail → Rudrans-fallback routing</>,
            <><code>hmac-token.ts</code> — HMAC-signed magic-link tokens (cred request flow)</>,
            <><code>auth-org.ts</code> — resolveWriterOrgId() helper (owner OR admin gating)</>,
          ]} />
        </Sub>
      </Section>

      <Section id="schema" title="7. Database schema (key tables)">
        <Sub title="Core">
          <KV k="organizations" v="Tenant root. owner_user_id, subscription_status, trial_ends_at, em_subscribed, em_sender_email, license_count, features (jsonb override map), recipient email arrays" />
          <KV k="org_members" v="user_id + org_id + role (owner/admin/viewer). Unique (org_id, email) for invites." />
          <KV k="app_users" v="Platform-level role (super_admin / partner / customer). Determines /admin and /partner access." />
          <KV k="agents" v="Enrolled desktop agents. agent_name, machine_name, os_type, last_active, dlp_enabled, version" />
          <KV k="activity_logs" v="Window/URL/title rows from agents. Indexed by (agent_id, ts)." />
          <KV k="screenshots / videos" v="Object metadata. Files stored in Supabase Storage buckets." />
          <KV k="alerts" v="AI / rule classifications. severity, type, ai_resolved." />
          <KV k="dlp_events" v="USB + email transfer events. Classification + AI reasoning." />
        </Sub>
        <Sub title="Employee Management">
          <KV k="employees" v="HR-side employee record. doj, lwd, status (active/offboarding/offboarded), department_id, manager_id" />
          <KV k="org_departments" v="Departments per org" />
          <KV k="org_integrations" v="One row per (org_id, provider) for m365 / google. tenant_id, refresh_token_enc, access_token_enc, last_sync_at" />
          <KV k="directory_users / directory_groups / directory_group_members" v="Mirror of M365 / Google directory. external_id, upn, account_enabled, is_writable, writable_reason" />
          <KV k="credentials" v="Encrypted password vault. password_enc via pgp_sym_encrypt." />
          <KV k="credential_assignments" v="Audit trail of every send. revoked_at + revoked_reason." />
          <KV k="credential_requests" v="Public form submissions. Manager/IT approval magic tokens." />
          <KV k="hardware_assets / hardware_assignments" v="IT inventory + append-only assignment history." />
          <KV k="offboardings / offboarding_events" v="4-stage offboarding flow." />
        </Sub>
        <Sub title="Billing">
          <KV k="partners" v="Approved channel partners. status, commission_rate." />
          <KV k="plans" v="Pricing plans (starter-5, growth-25, scale-100, em-unlimited, etc.)." />
          <KV k="licenses" v="Active subscription per org + plan. seat_count, expires_at." />
          <KV k="invoices" v="Customer-facing invoices." />
          <KV k="plan_upgrade_requests" v="Customer-initiated plan changes; super-admin approves." />
        </Sub>
        <Sub title="Audit + ops">
          <KV k="audit_log" v="Platform-wide audit trail (admin actions, login failures, lockouts)." />
          <KV k="employee_audit / offboarding_events" v="Per-feature event histories." />
          <KV k="integrations" v="Live-editable platform credentials (API keys, OAuth client secrets)." />
        </Sub>
      </Section>

      <Section id="rls" title="8. RLS / multi-tenancy">
        <Sub title="Helpers">
          <Code>{`-- Returns the set of org_ids the calling user belongs to.
create function user_org_ids() returns setof uuid language sql
security definer set search_path = public as $$
  select org_id from public.org_members where user_id = auth.uid()
$$;

-- True if caller is org owner or admin (write role).
create function is_org_writer(p_org uuid) returns boolean language sql
security definer set search_path = public as $$
  select coalesce((
    select role in ('owner','admin')
      from public.org_members
     where org_id = p_org and user_id = auth.uid()
     limit 1
  ), false)
$$;

-- True if caller has the platform-wide super_admin role.
create function is_super_admin() returns boolean language sql
security definer set search_path = public as $$
  select exists(
    select 1 from public.app_users
     where user_id = auth.uid() and app_role = 'super_admin'
  )
$$;`}</Code>
        </Sub>
        <Sub title="Pattern">
          <Code>{`-- Read: any org member can see their org's rows
create policy XXX_select on public.XXX
  for select using (org_id in (select user_org_ids()));

-- Write: only owners + admins
create policy XXX_write on public.XXX
  for all using (is_org_writer(org_id))
  with check (is_org_writer(org_id));`}</Code>
        </Sub>
        <Sub title="Views: security_invoker">
          <P>All <code>v_*</code> views were created with <code>SECURITY DEFINER</code> default → they bypassed RLS and leaked cross-tenant data. Migration <strong>0051</strong> fixed every view with <code>ALTER VIEW … SET (security_invoker = true)</code>. Now views honor the calling user's RLS context.</P>
        </Sub>
      </Section>

      <Section id="auth" title="9. Auth flows">
        <Sub title="Email + password">
          <P>Standard Supabase Auth. JWT issued on sign-in; access_token (1h) + refresh_token (30d). Session cookie auto-managed by supabase-js.</P>
        </Sub>
        <Sub title="OAuth (Google / Microsoft)">
          <Bullets items={[
            'signInWithOAuth → redirect to provider consent screen',
            'Provider redirects back to /auth/v1/callback?code=...',
            'GoTrue exchanges code for tokens, mints Rudrans session JWT, redirects to /post-login',
            'PostLogin route reads role and sends user to right dashboard',
          ]} />
        </Sub>
        <Sub title="Magic links (credential requests)">
          <Bullets items={[
            'HMAC-signed tokens generated in cred-request-* edge functions',
            'Single-use: each token has a unique nonce + manager_approve_token (first click wins)',
            'Tied to org + employee + request_id',
            'Manager / IT email contains links that decode the HMAC and apply the decision',
          ]} />
        </Sub>
        <Sub title="Brute-force protection">
          <P>migration 0057 added <code>record_failed_login(p_email, p_ip)</code>. After 10 failed attempts in 15 min, account is banned for 30 min via <code>banned_until</code>.</P>
        </Sub>
      </Section>

      <Section id="oauth-em" title="10. M365 / Google OAuth (Employee Management)">
        <Sub title="M365">
          <Bullets items={[
            'Multi-tenant directory app registered in Entra (client_id 59337732-854c-4b7f-813f-c1e1ce8d90c6).',
            'Customer admin clicks "Grant admin consent" → redirected to login.microsoftonline.com/common/adminconsent',
            'On accept, MS redirects back with ?tenant=...&admin_consent=True',
            'oauth-m365-callback persists tenant_id + scopes on org_integrations',
            'Per-request: mint app-only client_credentials token using customer tenant_id + our client_id/secret',
            'All Graph calls use the cached token (50 min TTL)',
          ]} />
        </Sub>
        <Sub title="Google Workspace">
          <Bullets items={[
            'Standard OAuth 2.0 Authorization Code flow with offline access',
            'Customer admin clicks "Sign in with Google" → Google consent screen → ?code=...',
            'oauth-google-callback exchanges code → refresh_token (offline) + access_token',
            'Encrypted refresh_token stored in org_integrations.refresh_token_enc',
            'Per-request: refresh access_token from refresh_token, cache + persist for reuse',
            'Scopes: admin.directory.user/group/group.member/domain.readonly/orgunit + gmail.send',
          ]} />
        </Sub>
      </Section>

      <Section id="email" title="11. Email delivery">
        <Sub title="Three routing tiers (in graph-email.ts)">
          <Bullets items={[
            'Tier 1: per-org M365 mailbox (em_sender_email + org_integrations.tenant_id with Mail.Send scope)',
            'Tier 2: per-org Gmail (em_sender_email + Google OAuth gmail.send scope)',
            'Tier 3: fallback to Rudrans mailbox (Microsoft tenant + AUTH_EMAIL_FROM)',
          ]} />
        </Sub>
        <P>Customer-facing emails (cred delivery, offboarding NOC, manager approval) automatically use Tier 1 or 2 if configured. System emails (signup, password reset) use Tier 3.</P>
      </Section>

      <Section id="storage" title="12. Storage / encryption">
        <Sub title="Buckets">
          <Bullets items={[
            'screenshots — private, RLS on file path uuid matching org_id',
            'videos — same',
            'releases — public, hosts agent installers + signed minisign update manifest',
          ]} />
        </Sub>
        <Sub title="Symmetric encryption">
          <P>Secrets at rest use <code>pgp_sym_encrypt_text_to_bytea(text, key)</code> via SECURITY DEFINER RPCs:</P>
          <Bullets items={[
            <><code>DIRECTORY_TOKEN_ENC_KEY</code> — encrypts org_integrations.refresh_token_enc / access_token_enc</>,
            <><code>CRED_VAULT_ENC_KEY</code> — encrypts credentials.password_enc</>,
          ]} />
          <P>Keys live as Postgres GUCs (database settings), not in app code. Only the SECURITY DEFINER functions can read them.</P>
        </Sub>
      </Section>

      <Section id="deployment" title="13. Deployment topology">
        <Sub title="Cloud (Supabase managed) — main production">
          <Code>{`Project ref: ttjazaxjhzvrzhptrpmd
URL:         https://ttjazaxjhzvrzhptrpmd.supabase.co
Region:      West US (Oregon)
Frontend:    https://ems.rudrans.com (Vercel or static via nginx ems.rudrans.com)
Auth:        Cloud-managed, GOTRUE_SITE_URL=https://ems.rudrans.com`}</Code>
        </Sub>
        <Sub title="Self-hosted (EC2 + Docker) — parallel">
          <Code>{`EC2:         54.241.176.28 (Ubuntu 22.04)
SSH:         ssh -i agent.pem ubuntu@54.241.176.28
Stack:       /opt/rudrans/supabase/docker/docker-compose.yml
API:         https://api-ems.rudrans.com (nginx → kong:8000 → auth/rest/realtime/functions)
Frontend:    https://ems.rudrans.com (nginx serves /var/www/rudrans-app/)
TLS:         Let's Encrypt via certbot`}</Code>
        </Sub>
        <Sub title="nginx hardening (migration 0057 + conf.d)">
          <Bullets items={[
            'Rate limits: auth 10 r/s, edge fn 30 r/s, REST 60 r/s (burst caps proportional)',
            'Connection cap: 50 concurrent per IP',
            'HSTS preload: max-age=63072000',
            'X-Frame-Options DENY · X-Content-Type-Options nosniff · Referrer-Policy strict-origin',
            'CSP on ems.rudrans.com whitelisting only Supabase + Razorpay + Google + Microsoft + readdy CDN',
            'gzip enabled with proper gzip_types (JS / CSS / JSON / SVG)',
            'proxy_buffer_size 128k for Supabase OAuth callback (long JWT in Set-Cookie)',
          ]} />
        </Sub>
      </Section>

      <Section id="security" title="14. Security controls (summary)">
        <Bullets items={[
          'TLS everywhere — HSTS preload, certbot auto-renew',
          'RLS on every table, security_invoker=true on every view',
          'JWT auth with short access tokens (1h), refresh rotation',
          'Brute-force lockout via record_failed_login() + banned_until',
          'pgp_sym_encrypt for tokens + credential passwords at rest',
          'HMAC-signed magic links (single-use) for cred-request flow',
          'Service-role keys NEVER reach the browser — only edge functions',
          'CORS allowlist + CSP on browser app',
          'nginx rate limiting per IP across auth / edge-fn / REST',
          'audit_log table records every super-admin action + login failure',
          'Self-protection: cannot disable / delete own admin, last admin protected',
        ]} />
        <Callout kind="warn" title="What we explicitly don't do">
          We do <strong>not</strong> obfuscate API payloads from browser DevTools. The browser is the endpoint — anything it can decrypt, the user can see. Real security comes from RLS + JWT + rate limiting, not from hiding payloads (which gives false confidence).
        </Callout>
      </Section>

      <Section id="cron" title="15. Scheduled jobs (pg_cron)">
        <KV k="sweep_offline_agents" v="Every minute. Flips agents silent > 150 s to status='offline'." />
        <KV k="directory_sync_cron" v="Every 5 min. Calls /functions/v1/directory-sync for every connected (m365 / google) tenant." />
        <KV k="vault_seed_cron" v="Periodic refresh of credential-vault metadata." />
        <KV k="retention_purge" v="Daily. Deletes screenshots/videos older than per-org retention setting." />
        <KV k="trial_renewal_enforcement" v="Daily. Flips trial → expired when trial_ends_at passes." />
      </Section>
    </DocsLayout>
  );
}
