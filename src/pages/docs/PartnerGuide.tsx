import DocsLayout, { Section, Sub, P, Steps, Bullets, Callout, Shot, KV } from './DocsLayout';

const sections = [
  { id: 'overview',      label: '1. Programme overview' },
  { id: 'apply',         label: '2. Apply to become a partner' },
  { id: 'dashboard',     label: '3. Partner Dashboard' },
  { id: 'add-customer',  label: '4. Add a customer' },
  { id: 'plans',         label: '5. Plans & pricing' },
  { id: 'commission',    label: '6. Commission' },
  { id: 'invoices',      label: '7. Invoices' },
  { id: 'profile',       label: '8. Profile & GST' },
  { id: 'support',       label: '9. Support' },
];

export default function PartnerGuide() {
  return (
    <DocsLayout
      title="Partner Portal Guide"
      subtitle="A walkthrough of the Rudrans channel-partner programme and the Partner Portal."
      sections={sections}
      accent="violet"
    >
      <Section id="overview" title="1. Programme overview">
        <P>The Rudrans channel-partner programme lets MSPs and resellers bring their own customers onto the Rudrans platform and earn ongoing commission.</P>
        <KV k="Commission" v="20% of every successful customer subscription, lifetime" />
        <KV k="Billing currency" v="INR (Indian Rupees), via Razorpay or direct bank transfer" />
        <KV k="Onboarding time" v="Apply → approval → portal access in 1-2 business days" />
        <KV k="Customer cap" v="None — bring as many customers as you can sell" />
      </Section>

      <Section id="apply" title="2. Apply to become a partner">
        <Sub title="2.1 Public application">
          <Steps items={[
            <>Visit <code className="text-violet-300">https://ems.rudrans.com/partner-signup</code>.</>,
            <>Fill: legal entity, contact person, work email, phone, GST + PAN, address, expected customer volume, sales pitch.</>,
            <>Submit. Rudrans super-admin reviews within 1-2 business days.</>,
          ]} />
          <Shot caption="Partner application form" />
        </Sub>
        <Sub title="2.2 After approval">
          <Bullets items={[
            'You receive an email with a magic link to set your portal password.',
            'Land at /partner/dashboard with your channel-partner identity active.',
            <>Login URL: <code className="text-violet-300">https://ems.rudrans.com/partner/login</code></>,
          ]} />
        </Sub>
      </Section>

      <Section id="dashboard" title="3. Partner Dashboard">
        <P>Your home screen at <code className="text-violet-300">/partner/dashboard</code>.</P>
        <Bullets items={[
          'Total customers (active + trial + suspended)',
          'Active subscriptions count',
          'MRR (monthly recurring revenue) routed through you',
          'Pending invoices',
          'Commission accrued this month + lifetime',
          'Recent customer activity timeline',
        ]} />
        <Shot caption="Partner dashboard with KPIs + commission summary" />
      </Section>

      <Section id="add-customer" title="4. Add a customer">
        <Sub title="4.1 From the portal">
          <Steps items={[
            <>Sidebar → <strong>Customers</strong> → <strong>+ New customer</strong>.</>,
            <>Fill organisation details: name, contact email, phone, GST (auto-pulls company info), PAN, address.</>,
            <>Pick the plan you're starting them on (Starter / Professional / EM Unlimited / custom).</>,
            <>Save. Rudrans sends the customer an email invite. They set their password and start their 14-day trial.</>,
          ]} />
          <Shot caption="New customer modal with plan picker" />
        </Sub>
        <Sub title="4.2 Customer relationship">
          <Bullets items={[
            'The customer is permanently tagged with your partner_id.',
            'Every invoice goes through you (Bill from your entity → customer; Rudrans bills you separately at the partner rate).',
            'You can view their licenses and invoices but not their employee/credentials data — that stays org-scoped to the customer.',
          ]} />
        </Sub>
      </Section>

      <Section id="plans" title="5. Plans & pricing">
        <P>Standard plans, billed in INR:</P>
        <KV k="Starter" v="₹ 53,999 / month · 5 agents · Productivity reports" />
        <KV k="Professional" v="₹ 2,10,000 / year · 25 agents · Reports + Screenshots + Video + AI alerts" />
        <KV k="EM Unlimited" v="₹ 8,500 / month · unlimited users · Employee Management suite only" />
        <KV k="Enterprise" v="Custom · 100+ agents · Everything + DLP + dedicated support — talk to Rudrans for partner rate" />
        <Sub title="Add-ons">
          <Bullets items={[
            'Employee Management Unlimited — ₹ 8,500 / month on top of any monitoring plan',
            'DLP USB + Email — included in Enterprise; available as add-on otherwise',
          ]} />
        </Sub>
        <Callout kind="info" title="Partner price">
          You always see two prices: the <strong>customer price</strong> (MRP) and the <strong>partner price</strong> (your cost). Commission = MRP − partner price ≈ 20% by default.
        </Callout>
      </Section>

      <Section id="commission" title="6. Commission">
        <Bullets items={[
          'Lifetime — every renewal a customer pays, you earn the cut.',
          'Accrues monthly on the 1st.',
          'Settled to your bank account within 7 working days of accrual.',
          'Dashboard shows real-time accrued + paid amounts.',
        ]} />
      </Section>

      <Section id="invoices" title="7. Invoices">
        <P>Two views in the sidebar:</P>
        <Sub title="Customer invoices">
          <Bullets items={[
            'Every invoice you raised on your customers via Rudrans.',
            'Status: pending / paid / overdue.',
            'Download PDF, mark paid, resend to customer.',
          ]} />
        </Sub>
        <Sub title="Rudrans invoices to you">
          <Bullets items={[
            'Monthly bill from Rudrans for the partner-rate of all active customer subscriptions.',
            'Auto-deducts your accrued commission before issuing the bill.',
            'Pay via Razorpay or NEFT.',
          ]} />
        </Sub>
      </Section>

      <Section id="profile" title="8. Profile & GST">
        <P>Sidebar → <strong>Profile</strong>. Keep these accurate — they appear on every invoice generated under your partner umbrella.</P>
        <Bullets items={[
          'Legal name, contact person, support email, phone',
          'GST + PAN + state code (GST auto-decoded from GSTIN)',
          'Address, city, state, postal code',
          'Bank details (for commission payouts)',
          'Company logo (shown on customer-facing invoices)',
        ]} />
      </Section>

      <Section id="support" title="9. Support">
        <Bullets items={[
          <>Tech / customer escalations: <code>partner-support@rudrans.com</code></>,
          <>Commission disputes: <code>accounts@rudrans.com</code></>,
          <>Onboarding help / training: schedule via partner Slack channel (link in welcome email).</>,
          'SLA: 1 business day for technical issues, 3 business days for accounting.',
        ]} />
      </Section>
    </DocsLayout>
  );
}
