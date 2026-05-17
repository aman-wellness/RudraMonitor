import { Suspense, lazy } from "react";
import type { RouteObject } from "react-router-dom";
import ProtectedRoute from "./ProtectedRoute";
import RequireEm from "../components/RequireEm";
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
const Dashboard = lazy(() => import("../pages/dashboard/page"));
const Monitoring = lazy(() => import("../pages/monitoring/page"));
const AgentDetail = lazy(() => import("../pages/agent-detail/page"));
const Agents = lazy(() => import("../pages/agents/page"));
const Setup = lazy(() => import("../pages/setup/page"));
const AdminPortal = lazy(() => import("../pages/admin-portal/page"));
const EmployeesIntegrations = lazy(() => import("../pages/employees/integrations/page"));
const EmployeesList = lazy(() => import("../pages/employees/page"));
const NewEmployee = lazy(() => import("../pages/employees/new/page"));
const NewM365User = lazy(() => import("../pages/employees/new/m365/page"));
const GroupsManager = lazy(() => import("../pages/employees/groups/page"));
const ManagersPage = lazy(() => import("../pages/employees/managers/page"));
const HardwareInventory = lazy(() => import("../pages/employees/hardware/page"));
const SubscriptionPage = lazy(() => import("../pages/subscription/page"));
const CredentialsVault = lazy(() => import("../pages/employees/credentials/page"));
const PublicCredentialsRequest = lazy(() => import("../pages/employees/credentials-request-public/page"));
const CredentialsDecisionResult = lazy(() => import("../pages/employees/credentials-decision-result/page"));
const OffboardingPipeline = lazy(() => import("../pages/employees/offboarding/page"));
const Reports = lazy(() => import("../pages/reports/page"));
const DlpPage = lazy(() => import("../pages/dlp/page"));
const Alerts = lazy(() => import("../pages/alerts/page"));
const SystemHealth = lazy(() => import("../pages/system-health/page"));
const PerformanceReports = lazy(() => import("../pages/performance-reports/page"));
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
const AdminLicenses = lazy(() => import("../pages/admin/licenses/page"));
const AdminInvoices = lazy(() => import("../pages/admin/invoices/page"));
const AdminPlans = lazy(() => import("../pages/admin/plans/page"));
const AdminAudit = lazy(() => import("../pages/admin/audit/page"));
const AdminDlp = lazy(() => import("../pages/admin/dlp/page"));
const AdminIntegrations = lazy(() => import("../pages/admin/integrations/page"));
const AdminStorage = lazy(() => import("../pages/admin/storage/page"));
const AdminUsers = lazy(() => import("../pages/admin/users/page"));
const DocsUserGuide = lazy(() => import("../pages/docs/UserGuide"));
const DocsPartnerGuide = lazy(() => import("../pages/docs/PartnerGuide"));
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
// Gate /employees/* behind the EM subscription (trial orgs pass through).
const em        = (el: React.ReactNode) => protect(<RequireEm>{el}</RequireEm>);

const routes: RouteObject[] = [
  { path: "/", element: <Home /> },
  { path: "/login", element: wrap(<Login />) },
  { path: "/signup", element: wrap(<Signup />) },
  { path: "/signup-success",  element: wrap(<SignupSuccess />) },
  { path: "/complete-signup", element: wrap(<CompleteSignup />) },
  { path: "/dashboard", element: protect(<Dashboard />) },
  { path: "/monitoring", element: protect(<Monitoring />) },
  { path: "/agents", element: protect(<Agents />) },
  { path: "/agents/:agentId", element: protect(<AgentDetail />) },
  { path: "/setup", element: protect(<Setup />) },
  { path: "/alerts", element: protect(<Alerts />) },
  { path: "/system-health", element: protect(<SystemHealth />) },
  { path: "/performance-reports", element: protect(<PerformanceReports />) },
  { path: "/admin-portal", element: protect(<AdminPortal />) },
  { path: "/reports", element: protect(<Reports />) },
  { path: "/dlp", element: protect(<DlpPage />) },

  // Employee Management — gated behind the EM subscription (trial orgs pass through).
  { path: "/employees",              element: em(<EmployeesList />) },
  { path: "/employees/new",          element: em(<NewEmployee />) },
  { path: "/employees/new/m365",     element: em(<NewM365User />) },
  { path: "/employees/groups",       element: em(<GroupsManager />) },
  { path: "/employees/managers",     element: em(<ManagersPage />) },
  { path: "/employees/hardware",     element: em(<HardwareInventory />) },
  { path: "/employees/credentials",  element: em(<CredentialsVault />) },
  { path: "/employees/offboarding",  element: em(<OffboardingPipeline />) },
  { path: "/employees/integrations", element: em(<EmployeesIntegrations />) },

  // Self-service subscription & add-on management (always available to org owner).
  { path: "/subscription",           element: protect(<SubscriptionPage />) },

  // Public credential-request form (unauthenticated; gated by HMAC-signed magic link from email)
  { path: "/r/credentials-request",  element: wrap(<PublicCredentialsRequest />) },
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
  { path: "/admin/licenses",  element: superAdmin(<AdminLicenses />) },
  { path: "/admin/invoices",  element: superAdmin(<AdminInvoices />) },
  { path: "/admin/plans",     element: superAdmin(<AdminPlans />) },
  { path: "/admin/dlp",       element: superAdmin(<AdminDlp />) },
  { path: "/admin/audit",     element: superAdmin(<AdminAudit />) },
  { path: "/admin/integrations", element: superAdmin(<AdminIntegrations />) },
  { path: "/admin/storage",      element: superAdmin(<AdminStorage />) },
  { path: "/admin/users",        element: superAdmin(<AdminUsers />) },
  { path: "/admin/docs/super-admin",  element: superAdmin(<DocsSuperAdmin />) },
  { path: "/admin/docs/architecture", element: superAdmin(<DocsArchitecture />) },

  // Public documentation
  { path: "/docs/user-guide",    element: wrap(<DocsUserGuide />) },
  { path: "/docs/partner-guide", element: wrap(<DocsPartnerGuide />) },

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
