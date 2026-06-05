import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from '@/context/ThemeContext';
import { useAuth } from '@/context/AuthContext';
import { useAlerts } from '@/lib/dataHooks';
import { useAppRole } from '@/lib/useAppRole';
import { useOrgRole } from '@/lib/useOrgRole';
import { useFeatures, type FeatureCode } from '@/lib/useFeatures';
import { useAppAccess } from '@/lib/useAppAccess';
import OtpRequestBanner from '@/components/OtpRequestBanner';
import TrialGraceBanner from '@/components/TrialGraceBanner';

const formatRelative = (iso: string) => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// Each sidebar item has TWO gates: an org-level subscription gate
// (`requires`, evaluated against useFeatures) and a per-user app_access
// gate (`access`, evaluated against useAppAccess from migration 0080).
// Both must pass for the item to appear. Owners + admins automatically
// pass the app_access gate; lower roles pass only when the admin has
// explicitly granted that feature on the user's row.
type SidebarLink = {
  label: string;
  href: string;
  icon: string;
  requires?: FeatureCode[];
  /** Per-user app_access code; matches APP_ACCESS_CODES in lib/useAppAccess. */
  access?: import('@/lib/useAppAccess').AppAccessCode;
};

const sidebarLinks: SidebarLink[] = [
  { label: 'Dashboard', href: '/dashboard', icon: 'ri-dashboard-3-line', access: 'dashboard' },
  { label: 'Agents', href: '/agents', icon: 'ri-team-line', requires: ['monitoring_basic'], access: 'agents' },
  { label: 'Monitoring', href: '/monitoring', icon: 'ri-computer-line', requires: ['monitoring_basic'], access: 'monitoring' },
  { label: 'Alerts', href: '/alerts', icon: 'ri-notification-3-line', requires: ['monitoring_basic'], access: 'alerts' },
  { label: 'DLP', href: '/dlp', icon: 'ri-shield-keyhole-line', requires: ['dlp'], access: 'dlp' },
  { label: 'System Health', href: '/system-health', icon: 'ri-heart-pulse-line', requires: ['monitoring_basic'], access: 'system_health' },
  { label: 'Performance', href: '/performance-reports', icon: 'ri-bar-chart-grouped-line', requires: ['monitoring_basic'], access: 'performance' },
  { label: 'Reports', href: '/reports', icon: 'ri-file-chart-line', requires: ['monitoring_basic'], access: 'reports' },
  { label: 'Agent Setup', href: '/setup', icon: 'ri-download-cloud-line', requires: ['monitoring_basic'], access: 'setup' },
  { label: 'Employees', href: '/employees', icon: 'ri-user-add-line', requires: ['employee_management'], access: 'employees' },
  { label: 'Groups & Teams', href: '/employees/groups', icon: 'ri-group-line', requires: ['employee_management'], access: 'groups' },
  { label: 'Managers', href: '/employees/managers', icon: 'ri-user-star-line', requires: ['employee_management'], access: 'managers' },
  { label: 'Credentials Vault', href: '/employees/credentials', icon: 'ri-key-2-line', requires: ['employee_management'], access: 'credentials' },
  { label: 'Auto-Invoice', href: '/employees/auto-invoice', icon: 'ri-file-list-3-line', requires: ['employee_management'], access: 'credentials' },
  { label: 'OTP Channels', href: '/employees/otp-settings', icon: 'ri-chat-check-line', requires: ['employee_management'], access: 'credentials' },
  { label: 'IT Hardware', href: '/employees/hardware', icon: 'ri-computer-line', requires: ['employee_management'], access: 'hardware' },
  { label: 'Offboarding', href: '/employees/offboarding', icon: 'ri-logout-box-line', requires: ['employee_management'], access: 'offboarding' },
  { label: 'Integrations', href: '/employees/integrations', icon: 'ri-plug-line', requires: ['employee_management'], access: 'integrations' },
  { label: 'Governance', href: '/governance', icon: 'ri-organization-chart', requires: ['employee_management'], access: 'governance' },
  { label: 'Admin Portal', href: '/admin-portal', icon: 'ri-shield-user-line', access: 'admin_portal' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const { isDark, toggleTheme } = useTheme();
  const { user, organization, signOut } = useAuth();
  const { rows: alertRows } = useAlerts({ sinceHours: 24, limit: 5 });
  const { role: appRole } = useAppRole();
  const features = useFeatures();
  const appAccess = useAppAccess();
  // Filter the sidebar by TWO gates:
  //   1. Org subscription includes the feature (`requires` → useFeatures).
  //   2. THIS user has the feature in their app_access (`access` →
  //      useAppAccess from migration 0080).
  // Both must pass. Items without a `requires` (Dashboard, Admin Portal)
  // still go through the access gate so a per-user scope of just
  // ['credentials'] actually leaves only Credentials Vault visible.
  // While EITHER hook is loading we HIDE gated items — otherwise the
  // sidebar flashes the full nav for ~200 ms then collapses, leaking
  // module names the user shouldn't be able to discover.
  const linkAllowed = (link: SidebarLink) => {
    // Subscription gate.
    if (link.requires) {
      if (features.loading) return false;
      const subOk = link.requires.every((code) => {
        switch (code) {
          case 'monitoring_basic': return features.monitoring_basic_enabled;
          case 'screenshots':      return features.screenshots_enabled;
          case 'videos':           return features.videos_enabled;
          case 'live':             return features.live_enabled;
          case 'remote':           return features.remote_enabled;
          case 'dlp':              return features.dlp_enabled;
          case 'employee_management': return features.em_enabled;
        }
      });
      if (!subOk) return false;
    }
    // Per-user access gate.
    if (link.access) {
      if (appAccess.loading) return false;
      if (!appAccess.unrestricted && !appAccess.allowed.has(link.access)) return false;
    }
    return true;
  };
  const visibleLinks = sidebarLinks.filter(linkAllowed).concat(
    appRole === 'super_admin'
      ? [{ label: 'Super Admin', href: '/admin/dashboard', icon: 'ri-shield-keyhole-line' }]
      : [],
  );
  const unresolvedAlerts = alertRows.filter((a) => !a.ai_resolved);

  const currentPath = location.pathname;

  const fullName =
    (user?.user_metadata?.full_name as string | undefined) ||
    user?.email?.split('@')[0] ||
    'Admin';
  const initials = fullName
    .split(' ')
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'A';
  const orgName = organization?.name ?? '—';

  const handleSignOut = async () => {
    await signOut();
    navigate('/', { replace: true });
  };

  return (
    <div className="dashboard-shell min-h-screen bg-dark-900 flex overflow-x-hidden">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-64 bg-dark-800 border-r border-dark-700 fixed left-0 top-0 bottom-0 z-30">
        {/* Logo */}
        <div className="h-16 flex items-center px-5 border-b border-dark-700">
          <Link to="/" className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="Rudrans"
              className="h-8 w-8 object-contain"
            />
            <span className="text-white font-poppins font-bold text-lg tracking-wide">
              Rudrans
            </span>
          </Link>
        </div>

        {/* Nav Links */}
        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto min-h-0">
          {visibleLinks.map((link) => {
            const active = currentPath === link.href;
            return (
              <Link
                key={link.href}
                to={link.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                  active
                    ? 'bg-emerald-500/10 text-emerald-400 border-l-2 border-emerald-500'
                    : 'text-gray-400 hover:text-white hover:bg-dark-700/50'
                }`}
              >
                <span className="w-5 h-5 flex items-center justify-center">
                  <i className={`${link.icon} text-base`} />
                </span>
                {link.label}
              </Link>
            );
          })}
        </nav>

        {/* User mini profile */}
        <div className="p-3 border-t border-dark-700">
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-dark-700/50 hover:bg-dark-700 transition-colors text-left"
            title="Sign out"
          >
            <div className="w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <span className="text-emerald-400 text-sm font-semibold">{initials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white font-medium truncate">{fullName}</p>
              <p className="text-xs text-gray-500 truncate">{orgName}</p>
            </div>
            <span className="w-4 h-4 flex items-center justify-center text-gray-500">
              <i className="ri-logout-box-r-line text-sm" />
            </span>
          </button>
        </div>
      </aside>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile Sidebar */}
      <aside
        className={`md:hidden fixed left-0 top-0 bottom-0 w-64 bg-dark-800 border-r border-dark-700 z-50 transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 flex items-center justify-between px-5 border-b border-dark-700">
          <Link to="/" className="flex items-center gap-3" onClick={() => setSidebarOpen(false)}>
            <img
              src="/logo.png"
              alt="Rudrans"
              className="h-8 w-8 object-contain"
            />
            <span className="text-white font-poppins font-bold text-lg">Rudrans</span>
          </Link>
          <button
            onClick={() => setSidebarOpen(false)}
            className="w-8 h-8 flex items-center justify-center text-gray-400"
            aria-label="Close sidebar"
          >
            <i className="ri-close-line text-xl" />
          </button>
        </div>
        <nav className="py-4 px-3 space-y-1 overflow-y-auto h-[calc(100vh-4rem)]">
          {visibleLinks.map((link) => {
            const active = currentPath === link.href;
            return (
              <Link
                key={link.href}
                to={link.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  active
                    ? 'bg-emerald-500/10 text-emerald-400 border-l-2 border-emerald-500'
                    : 'text-gray-400 hover:text-white hover:bg-dark-700/50'
                }`}
              >
                <span className="w-5 h-5 flex items-center justify-center">
                  <i className={`${link.icon} text-base`} />
                </span>
                {link.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <div className="flex-1 md:ml-64 min-h-screen flex flex-col min-w-0">
        {/* Top Header */}
        <header className="h-16 bg-dark-800/80 backdrop-blur-md border-b border-dark-700 flex items-center justify-between px-4 md:px-6 sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden w-9 h-9 flex items-center justify-center text-gray-400 hover:text-white"
              aria-label="Open sidebar"
            >
              <span className="w-5 h-5 flex items-center justify-center">
                <i className="ri-menu-line text-lg" />
              </span>
            </button>
            <h2 className="text-white font-poppins font-semibold text-sm md:text-base">
              Admin Dashboard
            </h2>
          </div>

          <div className="flex items-center gap-3 md:gap-5">
            {/* Search */}
            <div className="hidden sm:flex items-center bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5">
              <span className="w-4 h-4 flex items-center justify-center text-gray-500 mr-2">
                <i className="ri-search-line text-sm" />
              </span>
              <input
                type="text"
                placeholder="Search agents, alerts..."
                className="bg-transparent text-sm text-white placeholder-gray-600 focus:outline-none w-48 lg:w-64"
              />
            </div>

            {/* Notifications */}
            <div className="relative">
              <button
                onClick={() => setNotifOpen(!notifOpen)}
                className="w-9 h-9 flex items-center justify-center text-gray-400 hover:text-white relative"
                aria-label="Notifications"
              >
                <span className="w-5 h-5 flex items-center justify-center">
                  <i className="ri-notification-3-line text-lg" />
                </span>
                {unresolvedAlerts.length > 0 && (
                  <span className="absolute top-1 right-1 min-w-4 h-4 px-1 bg-red-500 rounded-full text-[10px] text-white flex items-center justify-center font-medium">
                    {unresolvedAlerts.length > 9 ? '9+' : unresolvedAlerts.length}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 top-11 w-72 bg-dark-800 border border-dark-700 rounded-xl shadow-2xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-dark-700 flex items-center justify-between">
                    <span className="text-sm text-white font-medium">Notifications</span>
                    <span className="text-xs text-emerald-400 cursor-pointer hover:text-emerald-300">
                      Mark all read
                    </span>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {alertRows.length === 0 ? (
                      <div className="px-4 py-6 text-center text-xs text-gray-500">
                        No recent alerts.
                      </div>
                    ) : (
                      alertRows.map((a) => (
                        <div key={a.id} className="px-4 py-3 border-b border-dark-700/50 hover:bg-dark-700/30 transition-colors cursor-pointer">
                          <div className="flex items-start gap-2.5">
                            <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                              a.alert_type === 'error' ? 'bg-red-500' : a.alert_type === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                            }`} />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs text-gray-300 leading-relaxed truncate">{a.message}</p>
                              <p className="text-[11px] text-gray-500 mt-1">
                                {a.agent_name ?? 'Agent'} · {formatRelative(a.created_at)}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="px-4 py-2.5 border-t border-dark-700 text-center">
                    <Link to="/alerts" className="text-xs text-emerald-400 hover:text-emerald-300 font-medium">
                      View all alerts
                    </Link>
                  </div>
                </div>
              )}
            </div>

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="w-9 h-9 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-700/50 transition-colors"
              title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              aria-label="Toggle theme"
            >
              <span className="w-5 h-5 flex items-center justify-center">
                <i className={isDark ? 'ri-sun-line text-lg' : 'ri-moon-line text-lg'} />
              </span>
            </button>

            {/* User Avatar + dropdown */}
            <div className="relative">
              <button
                onClick={() => setProfileOpen(!profileOpen)}
                className="w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center cursor-pointer hover:bg-emerald-500/30 transition-colors"
                aria-label="User menu"
              >
                <span className="text-emerald-400 text-sm font-semibold">{initials}</span>
              </button>
              {profileOpen && (
                <div className="absolute right-0 top-11 w-56 bg-dark-800 border border-dark-700 rounded-xl shadow-2xl z-50 overflow-hidden">
                  <div className="px-4 py-3 border-b border-dark-700">
                    <p className="text-sm text-white font-medium truncate">{fullName}</p>
                    <p className="text-xs text-gray-500 truncate">{user?.email}</p>
                  </div>
                  <button
                    onClick={handleSignOut}
                    className="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-dark-700/50 transition-colors flex items-center gap-2"
                  >
                    <i className="ri-logout-box-r-line text-base" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 min-w-0 w-full p-4 md:p-6 lg:p-8 overflow-y-auto overflow-x-hidden">
          <div className="w-full max-w-screen-2xl mx-auto">
            <ViewerBanner />
            <TrialGraceBanner />
            <OtpRequestBanner />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

// Read-only banner shown to viewers on every customer page so they know
// up-front why write controls are disabled.
function ViewerBanner() {
  const { isViewer } = useOrgRole();
  if (!isViewer) return null;
  return (
    <div className="mb-4 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center gap-2">
      <i className="ri-eye-line" />
      <span><strong>Viewer mode</strong> — read-only access. Ask your Org Admin if you need to make changes.</span>
    </div>
  );
}