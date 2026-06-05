// Landing-page section dedicated to the Employee Management module. Sits
// between the system-health section and the pricing section so visitors
// see the IT-lifecycle value-prop before they reach the price card.

import { Link } from 'react-router-dom';

const pillars = [
  {
    icon: 'ri-plug-line',
    title: 'One-click directory connect',
    blurb: 'Sign in to Microsoft 365 or Google Workspace once. Users, groups, Teams, and shared mailboxes sync into Rudrans automatically.',
    bullets: ['Multi-tenant Entra app', 'Google OAuth (refresh-token)', 'Read-only on-prem AD groups flagged', '5-min cron sync'],
  },
  {
    icon: 'ri-user-add-line',
    title: 'Provision new joiners',
    blurb: 'Create the M365 mailbox + license + temp password from one form. Welcome email goes from your own mailbox.',
    bullets: ['SKU picker with seat availability', 'Welcome email auto-sent to personal address', 'Manager + department + designation', 'Join date stamped automatically'],
  },
  {
    icon: 'ri-key-2-line',
    title: 'Credentials vault + request flow',
    blurb: 'Encrypted password store. Employees self-request via a public form → manager approves → IT dispatches — every step audited.',
    bullets: ['pgp_sym_encrypt at rest', 'HMAC-signed magic-link approvals', 'Bulk CSV import', 'Send-as your own mailbox'],
  },
  {
    icon: 'ri-computer-line',
    title: 'Hardware inventory + history',
    blurb: 'Every laptop, monitor, phone & peripheral tracked end-to-end. Assignment history is append-only — never lose who had what.',
    bullets: ['CSV upload with type/status auto-normalize', 'Per-device assignment timeline', 'Join + exit date columns', 'Auto-unassign on offboarding'],
  },
  {
    icon: 'ri-group-line',
    title: 'Groups & Teams manager',
    blurb: 'Bulk-edit M365 group, Teams, and Google group memberships from one diff screen. Read-only synced groups disabled with reason.',
    bullets: ['10 ops per submit', 'Dynamic-membership groups detected', 'Role-assignable groups flagged', 'Per-user owner / member role'],
  },
  {
    icon: 'ri-logout-box-line',
    title: '4-stage offboarding',
    blurb: 'Creds review → revoke access → device handover → NOC issued to HR + Accounts. Devices auto-unassign, exit date stamped.',
    bullets: ['Per-credential revoke checklist', 'Auto-pulled device list (multiple devices supported)', 'NOC email with full handover summary', 'History + monthly dashboard'],
  },
];

export default function EmployeeManagementSection() {
  return (
    <section id="employee-management" className="relative bg-dark-900 py-16 md:py-24">
      <div className="w-full px-4 md:px-8 lg:px-12 max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12 md:mb-16">
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-4">
            <i className="ri-team-line text-emerald-400 text-sm" />
            <span className="text-xs md:text-sm text-emerald-400 font-medium">
              Employee Management Suite
            </span>
          </div>
          <h2 className="text-2xl md:text-3xl lg:text-4xl font-poppins font-bold text-white mb-4">
            From onboarding to NOC, all in one place
          </h2>
          <p className="text-sm md:text-base text-gray-400 max-w-2xl mx-auto leading-relaxed">
            Provision M365 / Google users, manage groups &amp; teams, run a credentials vault with a self-service request workflow,
            track IT hardware end-to-end, and orchestrate offboarding — no more spreadsheets and Slack threads.
          </p>
        </div>

        {/* Pillars grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {pillars.map((p) => (
            <div key={p.title} className="group bg-dark-800 border border-dark-700 rounded-xl p-6 hover:border-emerald-500/40 transition-colors">
              <div className="w-11 h-11 rounded-lg bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 flex items-center justify-center mb-4">
                <i className={`${p.icon} text-emerald-400 text-xl`} />
              </div>
              <h3 className="text-base font-poppins font-semibold text-white mb-2">{p.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed mb-4">{p.blurb}</p>
              <ul className="space-y-1.5">
                {p.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2 text-xs text-gray-300">
                    <i className="ri-check-line text-emerald-400 text-sm mt-0.5 shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* CTA strip */}
        <div className="mt-12 bg-gradient-to-r from-emerald-500/10 via-cyan-500/10 to-violet-500/10 border border-emerald-500/25 rounded-2xl p-6 md:p-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-emerald-300 font-medium mb-1">Add-on or standalone</p>
            <h3 className="text-xl md:text-2xl font-poppins font-bold text-white mb-1">
              ₹ 8,500 / month · unlimited users
            </h3>
            <p className="text-sm text-gray-300">Layer on any monitoring plan, or run EM alone — no agents required.</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Link to="/signup" className="px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-medium">
              Start Free Trial
            </Link>
            <a href="#pricing" className="px-5 py-2.5 rounded-lg bg-dark-800 hover:bg-dark-700 border border-dark-700 text-white text-sm font-medium">
              See pricing
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
