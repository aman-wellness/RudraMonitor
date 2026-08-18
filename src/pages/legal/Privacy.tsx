// Privacy Policy — required for Google OAuth verification, GDPR/CCPA
// compliance, and basic global trust. Plain English. Update the "Last
// updated" line every time material content changes.

import { Link } from 'react-router-dom';
import LegalLayout from './LegalLayout';

export default function Privacy() {
  return (
    <LegalLayout title="Privacy Policy" lastUpdated="17 May 2026">
      <Section title="1. Who we are">
        <P>
          Rudrans is a workplace monitoring and employee-management SaaS operated by
          <strong> Rudrans India Private Limited</strong> ("we", "us", "Rudrans"),
          a company registered in India. Our registered support address is{' '}
          <a className="text-emerald-300" href="mailto:support@wellnessextract.com">support@wellnessextract.com</a>.
        </P>
        <P>
          This policy explains what data we collect when you (the customer) and your
          employees (the end users) use Rudrans, how we use that data, who we share
          it with, and the rights you have over it.
        </P>
      </Section>

      <Section title="2. Data we collect">
        <SubHeading>2.1 Account &amp; billing data</SubHeading>
        <Bullets items={[
          'Name, work email, phone number, password (hashed) of the person signing up',
          'Organisation name, GST number, PAN, address, country',
          'Payment metadata via Razorpay (we never store full card numbers)',
        ]} />
        <SubHeading>2.2 Employee-monitoring data (only collected on devices where your IT admin installs the agent)</SubHeading>
        <Bullets items={[
          'Active application window titles, browser URLs and page titles',
          'Periodic screenshots (interval configurable by your admin, default 5 min)',
          'Optional video clips on AI-detected events',
          'System health metrics (CPU, RAM, disk, network)',
          'USB transfer events and personal-email attachment events (DLP feature, opt-in)',
        ]} />
        <SubHeading>2.3 Directory data (only when you connect Microsoft 365 / Google Workspace)</SubHeading>
        <Bullets items={[
          'Users, groups, teams, distribution lists, shared mailboxes — mirrored read-only',
          'OAuth refresh tokens stored encrypted (pgp_sym_encrypt) so we can act on your behalf',
          'No mailbox content is read. We only call SendMail when your admin asks us to.',
        ]} />
      </Section>

      <Section title="3. How we use it">
        <Bullets items={[
          'To deliver the product the customer signed up for (dashboards, reports, alerts, NOC emails, etc.)',
          'To send transactional emails (sign-up, password reset, invoices, alerts)',
          'To detect abuse and protect the platform (rate limiting, brute-force lockout, audit log)',
          'To produce aggregated, non-identifying analytics on platform health',
          'We do not sell personal data to third parties. We do not use your data to train AI models that benefit other customers.',
        ]} />
      </Section>

      <Section title="4. Third parties we share data with">
        <Bullets items={[
          'Supabase (database + auth + storage) — hosted in Oregon, USA and on our own EC2 in us-west-1',
          'Microsoft Graph / Google Admin SDK — only the calls your admin authorised',
          'Anthropic (Claude) and OpenAI (GPT-4o-mini) — DLP classification only; both are no-training contracts',
          'Razorpay — payments only',
          'AWS — infrastructure (compute, storage, email relays)',
          'Cloudflare / nginx — TLS termination, rate limiting',
        ]} />
        <P>
          Each sub-processor signs a Data Processing Agreement with us. The current
          list can be re-issued on request to <a className="text-emerald-300" href="mailto:dpo@wellnessextract.com">dpo@wellnessextract.com</a>.
        </P>
      </Section>

      <Section title="5. Where data is stored">
        <Bullets items={[
          'Primary database: Supabase Cloud, West US (Oregon) region',
          'Mirror / self-hosted option: AWS EC2, us-west-1, encrypted EBS volumes',
          'Screenshots + videos: Supabase Storage with object-level RLS',
          'Backups: daily, 30-day retention',
        ]} />
        <P>
          Enterprise customers may request an EU or India residency on request — contact sales.
        </P>
      </Section>

      <Section title="6. How long we keep it">
        <Bullets items={[
          'Screenshots / videos: per-org retention setting (default 30 days, configurable up to 1 year)',
          'Activity logs: same as screenshots',
          'Audit log: 12 months',
          'Account data: until you delete the account, then 30 days in soft-delete, then permanent purge',
        ]} />
      </Section>

      <Section title="7. Your rights">
        <P>
          If you are an end user whose work device is monitored, you have the right
          to:
        </P>
        <Bullets items={[
          'Be informed by your employer that monitoring is in place (we require this in our Terms)',
          'Request a copy of the data Rudrans holds about you',
          'Request correction of inaccurate data',
          'Request deletion when you leave the employer',
        ]} />
        <P>
          Send any of these requests to your employer first; if they don't respond
          within 30 days, escalate to{' '}
          <a className="text-emerald-300" href="mailto:dpo@wellnessextract.com">dpo@wellnessextract.com</a>.
        </P>
        <P>
          If you are in the EU, you have additional rights under GDPR (portability,
          erasure, lodging a complaint with your DPA). If you are in California, you
          have additional rights under CCPA (right to know, delete, opt-out of sale —
          we don't sell data so opt-out is a no-op).
        </P>
      </Section>

      <Section title="8. Security">
        <Bullets items={[
          'TLS 1.2+ in transit (HSTS preload enrolled)',
          'AES-256 at rest (Supabase + EBS encryption)',
          'Row-level security enforced on every table',
          'Application secrets via pgp_sym_encrypt with keys held in Postgres GUC',
          'Brute-force protection: 10 failed sign-ins in 15 min → 30 min account lockout',
          'Audit log of every super-admin action',
          'Annual third-party penetration test (results available under NDA)',
        ]} />
      </Section>

      <Section title="9. Children">
        <P>
          Rudrans is a workplace tool. We do not knowingly process data of anyone
          under 16.
        </P>
      </Section>

      <Section title="10. Changes to this policy">
        <P>
          We will email account owners at least 14 days before any material change.
          The "Last updated" date at the top of this page reflects the most recent
          revision.
        </P>
      </Section>

      <Section title="11. Contact">
        <Bullets items={[
          <>General privacy: <a className="text-emerald-300" href="mailto:privacy@wellnessextract.com">privacy@wellnessextract.com</a></>,
          <>Data Protection Officer: <a className="text-emerald-300" href="mailto:dpo@wellnessextract.com">dpo@wellnessextract.com</a></>,
          <>Security disclosure: <a className="text-emerald-300" href="mailto:security@wellnessextract.com">security@wellnessextract.com</a></>,
        ]} />
        <P className="mt-6">
          See also: <Link to="/legal/terms" className="text-emerald-300 hover:underline">Terms of Service</Link>{' '}
          · <Link to="/docs/user-guide" className="text-emerald-300 hover:underline">User Guide</Link>
        </P>
      </Section>
    </LegalLayout>
  );
}

// ---- local components ----

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-poppins font-semibold text-white">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-poppins font-medium text-white mt-4 mb-2">{children}</h3>;
}
function P({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-sm text-gray-300 leading-relaxed ${className}`}>{children}</p>;
}
function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-1.5 list-disc list-inside text-sm text-gray-300">
      {items.map((it, i) => <li key={i} className="leading-relaxed">{it}</li>)}
    </ul>
  );
}
