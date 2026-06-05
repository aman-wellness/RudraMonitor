// Terms of Service. Customer-facing contract that governs every paid + trial
// use of Wellness Extract. Plain English, India-law governing.

import { Link } from 'react-router-dom';
import LegalLayout from './LegalLayout';

export default function Terms() {
  return (
    <LegalLayout title="Terms of Service" lastUpdated="17 May 2026">
      <Section title="1. Acceptance">
        <P>
          By signing up for or using Wellness Extract (the "Service"), you ("Customer") agree
          to these Terms of Service ("Terms"). If you do not agree, do not use the
          Service. The Service is operated by Wellness Extract India Private Limited
          ("Wellness Extract", "we", "us"), with registered support at{' '}
          <a className="text-emerald-300" href="mailto:support@wellnessextract.com">support@wellnessextract.com</a>.
        </P>
      </Section>

      <Section title="2. The Service">
        <Bullets items={[
          'A SaaS dashboard at ems.wellnessextract.com',
          'A desktop monitoring agent (Windows / macOS / Linux)',
          'Optional add-on modules: Employee Management, Data Loss Prevention (DLP)',
          'Email + chat support per your subscription tier',
        ]} />
      </Section>

      <Section title="3. Free trial">
        <Bullets items={[
          'Every new sign-up gets a 14-day free trial with every feature unlocked.',
          'No credit card required to start.',
          'If you do not subscribe by the end of the trial, your account is moved to a read-only state for 30 days, then deleted unless you reactivate.',
        ]} />
      </Section>

      <Section title="4. Subscriptions, fees & taxes">
        <Bullets items={[
          'Plans and prices are shown at /pricing on our website. Prices are exclusive of GST or other applicable taxes.',
          'Indian customers are billed in INR via Razorpay. International customers are billed in USD via Stripe (rolling out).',
          'Subscriptions auto-renew monthly or yearly per the plan you select. You can cancel anytime from /admin-portal → Subscription.',
          'Cancellation takes effect at the end of the current paid period. No partial refunds for the unused remainder.',
          <>Channel-partner customers are billed by their partner. Disputes route to the partner first; if unresolved within 30 days, escalate to <a className="text-emerald-300" href="mailto:accounts@wellnessextract.com">accounts@wellnessextract.com</a>.</>,
        ]} />
      </Section>

      <Section title="5. Customer obligations">
        <Bullets items={[
          'You must obtain consent from your employees before deploying the monitoring agent on their devices. This is the law in most jurisdictions.',
          'You must inform employees what data is collected (refer them to our User Guide or your internal policy).',
          'You may not use the Service to monitor employees outside your legal entity or contractors who have not consented.',
          'You are responsible for the actions of users you invite (org admins, viewers).',
          'You are responsible for keeping API keys, license keys, and other secrets confidential.',
        ]} />
      </Section>

      <Section title="6. Acceptable use">
        <P>You agree not to:</P>
        <Bullets items={[
          'Reverse-engineer, decompile, or disassemble the Service or agent',
          'Use the Service to violate any law or third-party right',
          'Resell the Service without becoming an authorised channel partner',
          'Attempt to access other customers\' data, accounts, or infrastructure',
          'Run automated scrapers or send abusive traffic against our endpoints',
          'Use the Service to harass, stalk, or otherwise harm any individual',
        ]} />
        <P>
          Violation may result in immediate suspension of your account.
        </P>
      </Section>

      <Section title="7. Data & privacy">
        <P>
          Your collection, use, and sharing of data via the Service is governed by
          our <Link to="/legal/privacy" className="text-emerald-300 hover:underline">Privacy Policy</Link>.
          You retain ownership of all customer data you upload. We act as a processor
          of that data; you are the controller. We sign a Data Processing Agreement on
          request — email{' '}
          <a className="text-emerald-300" href="mailto:dpo@wellnessextract.com">dpo@wellnessextract.com</a>.
        </P>
      </Section>

      <Section title="8. Intellectual property">
        <Bullets items={[
          'Wellness Extract, the agent, all source code, documentation, and brand assets remain our property.',
          'You receive a non-exclusive, non-transferable licence to use the Service for the duration of your paid subscription.',
          'You may not remove copyright notices or attempt to obscure the origin of the Service.',
        ]} />
      </Section>

      <Section title="9. Warranties & disclaimers">
        <P>
          We provide the Service "AS IS" without warranty of merchantability, fitness
          for a particular purpose, or non-infringement. While we make commercially
          reasonable efforts to keep the Service available, no SaaS is 100% uptime.
          Specific uptime guarantees are available only under Enterprise contracts.
        </P>
      </Section>

      <Section title="10. Limitation of liability">
        <P>
          To the maximum extent permitted by law, our aggregate liability for any
          claim arising from these Terms or your use of the Service shall not exceed
          the fees you paid us in the 12 months immediately preceding the claim.
          Neither party shall be liable for indirect, incidental, consequential, or
          punitive damages.
        </P>
      </Section>

      <Section title="11. Termination">
        <Bullets items={[
          'You may cancel anytime from the admin portal.',
          'We may suspend or terminate your account for material breach of these Terms with 14 days written notice (immediate suspension for security incidents, fraud, or violation of acceptable use).',
          'On termination, you lose access to the Service. We delete your data per the schedule in our Privacy Policy.',
        ]} />
      </Section>

      <Section title="12. Governing law & dispute resolution">
        <P>
          These Terms are governed by the laws of India. Any dispute shall first be
          attempted to be resolved through good-faith negotiation. Failing that, the
          courts at New Delhi shall have exclusive jurisdiction.
        </P>
        <P>
          For international customers, applicable consumer-protection laws in your
          country of residence override conflicting clauses to the extent required.
        </P>
      </Section>

      <Section title="13. Changes to these Terms">
        <P>
          We will email account owners at least 14 days before any material change.
          Continued use after the change takes effect constitutes acceptance.
        </P>
      </Section>

      <Section title="14. Contact">
        <Bullets items={[
          <>Sales: <a className="text-emerald-300" href="mailto:sales@wellnessextract.com">sales@wellnessextract.com</a></>,
          <>Support: <a className="text-emerald-300" href="mailto:support@wellnessextract.com">support@wellnessextract.com</a></>,
          <>Accounts / billing: <a className="text-emerald-300" href="mailto:accounts@wellnessextract.com">accounts@wellnessextract.com</a></>,
          <>Legal notice: <a className="text-emerald-300" href="mailto:legal@wellnessextract.com">legal@wellnessextract.com</a></>,
        ]} />
        <P className="mt-6">
          See also: <Link to="/legal/privacy" className="text-emerald-300 hover:underline">Privacy Policy</Link>
        </P>
      </Section>
    </LegalLayout>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-poppins font-semibold text-white">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
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
