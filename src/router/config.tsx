import { Suspense, lazy } from "react";
import type { RouteObject } from "react-router-dom";
import { Navigate } from "react-router-dom";
import DashboardLayout from "../pages/dashboard/DashboardLayout";
import ProtectedRoute from "./ProtectedRoute";
import RequireEm from "../components/RequireEm";
import RequireFeature from "../components/RequireFeature";
import RequireAccess from "../components/RequireAccess";
import type { AppAccessCode } from "../lib/useAppAccess";
import type { FeatureCode } from "../lib/useFeatures";
import { RequireSuperAdmin, RequirePartner } from "../lib/RequireRole";

// Marketing pages: keep Home eager so the landing page paints instantly.
import Home from "../pages/home/page";
import NotFound from "../pages/NotFound";

// Everything else: lazy-loaded so the initial bundle stays small.
// Heavy form pages (employees/*) pull in country-state-city (~8 MB), which is
// why route-level splitting matters here.
const Login = lazy(() => import("../pages/login/page"));
const Signup = lazy(() => import("../pages/signup/page"));
const SignupSuccess = lazy(() => import("../pages/signup-success/page"));
const CompleteSignup = lazy(() => import("../pages/complete-signup/page"));
const OAuthMobileBridge = lazy(() => import("../pages/oauth-mobile-bridge/page"));
const AcceptInvite = lazy(() => import("../pages/accept-invite/page"));
const Dashboard = lazy(() => import("../pages/dashboard/page"));
const Monitoring = lazy(() => import("../pages/monitoring/page"));
const AgentDetail = lazy(() => import("../pages/agent-detail/page"));
const Agents = lazy(() => import("../pages/agents/page"));
const Setup = lazy(() => import("../pages/setup/page"));
const AdminPortal = lazy(() => import("../pages/admin-portal/page"));
const EmployeesIntegrations = lazy(() => import("../pages/employees/integrations/page"));
const EmployeesEmailSignatures = lazy(() => import("../pages/employees/email-signatures/page"));
const Governance = lazy(() => import("../pages/governance/page"));
// OrgSettings page merged into Admin Portal's "Branding & Policies" tab.
// Lazy import removed (unused) — the page file is retained at
// src/pages/org-settings/page.tsx for reference until cleanup, and the
// /org-settings route now redirects to /admin-portal.
const EmployeesList = lazy(() => import("../pages/employees/page"));
const NewEmployee = lazy(() => import("../pages/employees/new/page"));
const NewM365User = lazy(() => import("../pages/employees/new/m365/page"));
const GroupsManager = lazy(() => import("../pages/employees/groups/page"));
const ManagersPage = lazy(() => import("../pages/employees/managers/page"));
const HardwareInventory = lazy(() => import("../pages/employees/hardware/page"));
const SubscriptionPage = lazy(() => import("../pages/subscription/page"));
const Checkout = lazy(() => import("../pages/checkout/page"));
const AddonSeats = lazy(() => import("../pages/addon-seats/page"));
const CredentialsVault = lazy(() => import("../pages/employees/credentials/page"));
const PublicCredentialsRequest = lazy(() => import("../pages/employees/credentials-request-public/page"));
const OtpRespond = lazy(() => import("../pages/otp/respond"));
const OtpSettings = lazy(() => import("../pages/employees/otp-settings/page"));
const AutoInvoice = lazy(() => import("../pages/employees/auto-invoice/page"));
const CredentialsDecisionResult = lazy(() => import("../pages/employees/credentials-decision-result/page"));
const OffboardingPipeline = lazy(() => import("../pages/employees/offboarding/page"));
const Reports = lazy(() => import("../pages/reports/page"));
const DlpPage = lazy(() => import("../pages/dlp/page"));
const Alerts = lazy(() => import("../pages/alerts/page"));
const SystemHealth = lazy(() => import("../pages/system-health/page"));
// PerformanceReports merged into Reports; route kept as a redirect.
// Lazy import removed (unused) — page file retained at
// src/pages/performance-reports/page.tsx for reference until cleanup.
const PostLogin = lazy(() => import("../pages/post-login/page"));
const PartnerSignup = lazy(() => import("../pages/partner-signup/page"));
const PartnerLogin = lazy(() => import("../pages/partner-login/page"));
const SuperLogin = lazy(() => import("../pages/super-login/page"));
const ResetPassword = lazy(() => import("../pages/reset-password/page"));
const AdminDashboard = lazy(() => import("../pages/admin/dashboard/page"));
const AdminPartners = lazy(() => import("../pages/admin/partners/page"));
const AdminPartnerDetail = lazy(() => import("../pages/admin/partners/detail"));
const AdminCustomers = lazy(() => import("../pages/admin/customers/page"));
const AdminCustomerDetail = lazy(() => import("../pages/admin/customers/detail"));
const AdminTrialRequests = lazy(() => import("../pages/admin/trial-requests/page"));
const AdminLicenses = lazy(() => import("../pages/admin/licenses/page"));
const AdminInvoices = lazy(() => import("../pages/admin/invoices/page"));
const AdminPlans = lazy(() => import("../pages/admin/plans/page"));
const AdminMarketing = lazy(() => import("../pages/admin/marketing/page"));
const AdminAudit = lazy(() => import("../pages/admin/audit/page"));
const AdminDlp = lazy(() => import("../pages/admin/dlp/page"));
const AdminIntegrations = lazy(() => import("../pages/admin/integrations/page"));
const AdminBillingEntity = lazy(() => import("../pages/admin/billing-entity/page"));
const InvoicePage = lazy(() => import("../pages/invoice/page"));
const AdminStorage = lazy(() => import("../pages/admin/storage/page"));
const AdminUsers = lazy(() => import("../pages/admin/users/page"));
const AdminFeatureFlags = lazy(() => import("../pages/admin/feature-flags/page"));
const DocsUserGuide = lazy(() => import("../pages/docs/UserGuide"));
const DocsPartnerGuide = lazy(() => import("../pages/docs/PartnerGuide"));
const DocsIntegrations = lazy(() => import("../pages/docs/IntegrationsGuide"));
const DocsDeployment = lazy(() => import("../pages/docs/Deployment"));
const DocsSuperAdmin = lazy(() => import("../pages/docs/SuperAdminGuide"));
const DocsArchitecture = lazy(() => import("../pages/docs/Architecture"));
const LegalPrivacy = lazy(() => import("../pages/legal/Privacy"));
const LegalTerms = lazy(() => import("../pages/legal/Terms"));
const PartnerDashboard = lazy(() => import("../pages/partner/dashboard/page"));
const PartnerCustomers = lazy(() => import("../pages/partner/customers/page"));
const PartnerLicenses = lazy(() => import("../pages/partner/licenses/page"));
const PartnerInvoices = lazy(() => import("../pages/partner/invoices/page"));
const PartnerProfile = lazy(() => import("../pages/partner/profile/page"));

const Fallback = () => (
  <div className="min-h-screen flex items-center justify-center bg-dark-950">
    <div className="text-sm text-gray-400">Loading…</div>
  </div>
);

const wrap = (el: React.ReactNode) => <Suspense fallback={<Fallback />}>{el}</Suspense>;
const protect = (el: React.ReactNode) => wrap(<ProtectedRoute>{el}</ProtectedRoute>);
const superAdmin = (el: React.ReactNode) => protect(<RequireSuperAdmin>{el}</RequireSuperAdmin>);
const partner    = (el: React.ReactNode) => protect(<RequirePartner>{el}</RequirePartner>);
// Per-user access gate (org_members.app_access from migration 0080).
// Owners + admins pass automatically; lower roles see the page only
// when the admin has granted the matching code in their app_access.
const access    = (code: AppAccessCode, el: React.ReactNode) =>
  <RequireAccess code={code}>{el}</RequireAccess>;
// Gate /employees/* behind the EM subscription (trial orgs pass through).
const em        = (el: React.ReactNode, code?: AppAccessCode) =>
  protect(<RequireEm>{code ? access(code, el) : el}</RequireEm>);
// Generic feature gate — route renders only when the org has the named
// feature (or is on trial). Used for /dlp and any future
// feature-restricted routes that aren't EM-suite.
const requires = (code: FeatureCode, el: React.ReactNode, accessCode?: AppAccessCode) =>
  protect(<RequireFeature code={code}>{accessCode ? access(accessCode, el) : el}</RequireFeature>);

const routes: RouteObject[] = [
  { path: "/", element: <Home /> },
  { path: "/login", element: wrap(<Login />) },
  { path: "/signup", element: wrap(<Signup />) },
  { path: "/signup-success",  element: wrap(<SignupSuccess />) },
  { path: "/complete-signup", element: wrap(<CompleteSignup />) },
  { path: "/accept-invite",   element: wrap(<AcceptInvite />) },
  // OAuth bridge for the Capacitor mobile app on phones whose default
  // browser can't handle custom-scheme redirects (HeyTapBrowser, Samsung
  // Internet, etc.). Public, no auth gate — the page just forwards to
  // the app's custom URL scheme.
  { path: "/oauth-mobile-bridge", element: wrap(<OAuthMobileBridge />) },
  // ── DASHBOARD LAYOUT ─────────────────────────────────────────────
  // All customer-facing pages that render inside the sidebar+header
  // chrome are grouped under ONE parent layout-route. React Router
  // mounts <DashboardLayout/> once for the first match and keeps it
  // mounted across child route changes — only the <Outlet/> swaps.
  //
  // Result: sidebar never remounts, sidebar-scoped Supabase queries
  // (useAlerts, useFeatures, useAppAccess, useAppRole) fire ONCE per
  // session, and alert-realtime subscriptions stay open.
  //
  // The 26 pages inside still wrap themselves in <DashboardLayout> at
  // the JSX level; DashboardLayout detects the nested-mount context
  // and short-circuits to a passthrough. So no page files change.
  {
    element: <DashboardLayout />,
    children: [
      { path: "/dashboard", element: protect(access("dashboard", <Dashboard />)) },
      // Monitoring family — require the basic monitoring feature. EM-only
      // customers (who haven't bought any monitoring tier) get the upgrade CTA.
      { path: "/monitoring", element: requires("monitoring_basic", <Monitoring />, "monitoring") },
      { path: "/agents", element: requires("monitoring_basic", <Agents />, "agents") },
      { path: "/agents/:agentId", element: requires("monitoring_basic", <AgentDetail />, "agents") },
      { path: "/setup", element: requires("monitoring_basic", <Setup />, "setup") },
      { path: "/alerts", element: requires("monitoring_basic", <Alerts />, "alerts") },
      { path: "/system-health", element: requires("monitoring_basic", <SystemHealth />, "system_health") },
      // Legacy redirects — pages were merged.
      { path: "/performance-reports", element: <Navigate to="/reports" replace /> },
      { path: "/org-settings",        element: <Navigate to="/admin-portal" replace /> },
      { path: "/admin-portal", element: protect(access("admin_portal", <AdminPortal />)) },
      { path: "/reports", element: requires("monitoring_basic", <Reports />, "reports") },
      // DLP — its own feature flag. Available on Pro, Enterprise, or as add-on
      // layered onto Starter.
      { path: "/dlp", element: requires("dlp", <DlpPage />, "dlp") },

      // Employee Management — gated behind the EM subscription (trial orgs pass through).
      { path: "/employees",              element: em(<EmployeesList />, "employees") },
      { path: "/employees/new",          element: em(<NewEmployee />, "employees") },
      { path: "/employees/new/m365",     element: em(<NewM365User />, "employees") },
      { path: "/employees/groups",       element: em(<GroupsManager />, "groups") },
      { path: "/employees/managers",     element: em(<ManagersPage />, "managers") },
      { path: "/employees/hardware",     element: em(<HardwareInventory />, "hardware") },
      { path: "/employees/credentials",  element: em(<CredentialsVault />, "credentials") },
      { path: "/employees/offboarding",  element: em(<OffboardingPipeline />, "offboarding") },
      { path: "/employees/integrations", element: em(<EmployeesIntegrations />, "integrations") },
      { path: "/employees/email-signatures", element: em(<EmployeesEmailSignatures />, "integrations") },
      { path: "/employees/otp-settings", element: protect(access("credentials", <OtpSettings />)) },
      { path: "/employees/auto-invoice", element: protect(access("credentials", <AutoInvoice />)) },

      // Governance — pillars, org chart, channels, access register, policies.
      { path: "/governance",             element: em(<Governance />, "governance") },

      // Self-service subscription & add-on management.
      { path: "/subscription",           element: protect(<SubscriptionPage />) },
      { path: "/checkout",               element: protect(<Checkout />) },
      { path: "/addon-seats",            element: protect(<AddonSeats />) },
    ],
  },

  // Public credential-request form (unauthenticated; gated by HMAC-signed magic link from email)
  { path: "/r/credentials-request",  element: wrap(<PublicCredentialsRequest />) },
  { path: "/otp/:requestId",         element: wrap(<OtpRespond />) },
  { path: "/r/decision",             element: wrap(<CredentialsDecisionResult />) },

  // Post-login role router
  { path: "/post-login", element: protect(<PostLogin />) },

  // Public partner application
  { path: "/partner-signup", element: wrap(<PartnerSignup />) },

  // Partner-only login (linked from landing page header)
  { path: "/partner/login", element: wrap(<PartnerLogin />) },

  // Super-admin secret login (NOT linked anywhere — internal access only)
  { path: "/super", element: wrap(<SuperLogin />) },

  // Password reset landing page (Supabase recovery links redirect here).
  // Picks role-aware accent + post-reset destination automatically.
  { path: "/reset-password", element: wrap(<ResetPassword />) },

  // Super-admin portal (us)
  { path: "/admin/dashboard", element: superAdmin(<AdminDashboard />) },
  { path: "/admin/partners",  element: superAdmin(<AdminPartners />) },
  { path: "/admin/partners/:partnerId", element: superAdmin(<AdminPartnerDetail />) },
  { path: "/admin/customers", element: superAdmin(<AdminCustomers />) },
  { path: "/admin/customers/:customerId", element: superAdmin(<AdminCustomerDetail />) },
  { path: "/admin/trial-requests", element: superAdmin(<AdminTrialRequests />) },
  { path: "/admin/licenses",  element: superAdmin(<AdminLicenses />) },
  { path: "/admin/invoices",  element: superAdmin(<AdminInvoices />) },
  { path: "/admin/plans",     element: superAdmin(<AdminPlans />) },
  { path: "/admin/marketing", element: superAdmin(<AdminMarketing />) },
  { path: "/admin/dlp",       element: superAdmin(<AdminDlp />) },
  { path: "/admin/audit",     element: superAdmin(<AdminAudit />) },
  { path: "/admin/integrations", element: superAdmin(<AdminIntegrations />) },
  { path: "/admin/billing-entity", element: superAdmin(<AdminBillingEntity />) },
  { path: "/invoices/:id",           element: protect(<InvoicePage />) },
  { path: "/admin/storage",      element: superAdmin(<AdminStorage />) },
  { path: "/admin/users",        element: superAdmin(<AdminUsers />) },
  { path: "/admin/feature-flags", element: superAdmin(<AdminFeatureFlags />) },
  { path: "/admin/docs/super-admin",  element: superAdmin(<DocsSuperAdmin />) },
  { path: "/admin/docs/architecture", element: superAdmin(<DocsArchitecture />) },

  // Public documentation
  { path: "/docs/user-guide",    element: wrap(<DocsUserGuide />) },
  { path: "/docs/partner-guide", element: wrap(<DocsPartnerGuide />) },
  { path: "/docs/integrations",  element: wrap(<DocsIntegrations />) },
  { path: "/docs/deployment",    element: wrap(<DocsDeployment />) },

  // Public legal pages
  { path: "/legal/privacy", element: wrap(<LegalPrivacy />) },
  { path: "/legal/terms",   element: wrap(<LegalTerms />) },

  // Partner portal
  { path: "/partner/dashboard", element: partner(<PartnerDashboard />) },
  { path: "/partner/customers", element: partner(<PartnerCustomers />) },
  { path: "/partner/licenses",  element: partner(<PartnerLicenses />) },
  { path: "/partner/invoices",  element: partner(<PartnerInvoices />) },
  { path: "/partner/profile",   element: partner(<PartnerProfile />) },

  { path: "*", element: <NotFound /> },
];

export default routes;
