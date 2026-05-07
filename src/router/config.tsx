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

const protect = (el: React.ReactNode) => <ProtectedRoute>{el}</ProtectedRoute>;

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
  { path: "*", element: <NotFound /> },
];

export default routes;
