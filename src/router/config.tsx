import type { RouteObject } from "react-router-dom";
import NotFound from "../pages/NotFound";
import Home from "../pages/home/page";
import Login from "../pages/login/page";
import Signup from "../pages/signup/page";
import Dashboard from "../pages/dashboard/page";
import Monitoring from "../pages/monitoring/page";
import AgentDetail from "../pages/agent-detail/page";
import Agents from "../pages/agents/page";
import Setup from "../pages/setup/page";
import AdminPortal from "../pages/admin-portal/page";
import Reports from "../pages/reports/page";
import Alerts from "../pages/alerts/page";
import SystemHealth from "../pages/system-health/page";
import PerformanceReports from "../pages/performance-reports/page";
import ProtectedRoute from "./ProtectedRoute";
import PostLogin from "../pages/post-login/page";
import PartnerSignup from "../pages/partner-signup/page";
import PartnerLogin from "../pages/partner-login/page";
import SuperLogin from "../pages/super-login/page";
import AdminDashboard from "../pages/admin/dashboard/page";
import AdminPartners from "../pages/admin/partners/page";
import AdminCustomers from "../pages/admin/customers/page";
import AdminCustomerDetail from "../pages/admin/customers/detail";
import AdminLicenses from "../pages/admin/licenses/page";
import AdminInvoices from "../pages/admin/invoices/page";
import AdminPlans from "../pages/admin/plans/page";
import AdminAudit from "../pages/admin/audit/page";
import PartnerDashboard from "../pages/partner/dashboard/page";
import PartnerCustomers from "../pages/partner/customers/page";
import PartnerLicenses from "../pages/partner/licenses/page";
import PartnerInvoices from "../pages/partner/invoices/page";
import PartnerPlaceholder from "../pages/partner/Placeholder";
import { RequireSuperAdmin, RequirePartner } from "../lib/RequireRole";

const protect = (el: React.ReactNode) => <ProtectedRoute>{el}</ProtectedRoute>;
const superAdmin = (el: React.ReactNode) => protect(<RequireSuperAdmin>{el}</RequireSuperAdmin>);
const partner    = (el: React.ReactNode) => protect(<RequirePartner>{el}</RequirePartner>);

const routes: RouteObject[] = [
  { path: "/", element: <Home /> },
  { path: "/login", element: <Login /> },
  { path: "/signup", element: <Signup /> },
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

  // Post-login role router
  { path: "/post-login", element: protect(<PostLogin />) },

  // Public partner application
  { path: "/partner-signup", element: <PartnerSignup /> },

  // Partner-only login (linked from landing page header)
  { path: "/partner/login", element: <PartnerLogin /> },

  // Super-admin secret login (NOT linked anywhere — internal access only)
  { path: "/super", element: <SuperLogin /> },

  // Super-admin portal (us)
  { path: "/admin/dashboard", element: superAdmin(<AdminDashboard />) },
  { path: "/admin/partners",  element: superAdmin(<AdminPartners />) },
  { path: "/admin/customers", element: superAdmin(<AdminCustomers />) },
  { path: "/admin/customers/:customerId", element: superAdmin(<AdminCustomerDetail />) },
  { path: "/admin/licenses",  element: superAdmin(<AdminLicenses />) },
  { path: "/admin/invoices",  element: superAdmin(<AdminInvoices />) },
  { path: "/admin/plans",     element: superAdmin(<AdminPlans />) },
  { path: "/admin/audit",     element: superAdmin(<AdminAudit />) },

  // Partner portal
  { path: "/partner/dashboard", element: partner(<PartnerDashboard />) },
  { path: "/partner/customers", element: partner(<PartnerCustomers />) },
  { path: "/partner/licenses",  element: partner(<PartnerLicenses />) },
  { path: "/partner/invoices",  element: partner(<PartnerInvoices />) },
  { path: "/partner/profile",   element: partner(<PartnerPlaceholder title="Profile" hint="Your partner details and bank account." />) },

  { path: "*", element: <NotFound /> },
];

export default routes;
