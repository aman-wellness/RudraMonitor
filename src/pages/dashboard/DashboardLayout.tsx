import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

// Set to `true` for any descendant rendered inside a real DashboardLayout
// chrome. Nested <DashboardLayout> instances read this and skip rendering
// their own sidebar/header — they pass children through instead. This is
// how 26 dashboard pages can keep their `<DashboardLayout>...` wrappers
// while the router promotes ONE DashboardLayout to a parent layout-route
// that survives navigation. Without this, route changes would unmount
// the page → unmount its inner DashboardLayout → refire every Supabase
// query the sidebar depends on.
const DashboardLayoutMounted = createContext(false);
import { useTheme } from '@/context/ThemeContext';
import { useAuth } from '@/context/AuthContext';
import { useAlerts } from '@/lib/dataHooks';
import { useAppRole } from '@/lib/useAppRole';
import { useOrgRole } from '@/lib/useOrgRole';
import { useFeatures, type FeatureCode } from '@/lib/useFeatures';
import { useAppAccess } from '@/lib/useAppAccess';
import { useGlobalFeatureFlags } from '@/lib/useGlobalFeatureFlags';
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
  /** Global feature-flag code; matches a row in `app_features` table.
   *  When that flag is disabled, this link is hidden globally regardless
   *  of org features / user access. Used for half-built or preview
   *  features the super admin hasn't enabled yet. */
  flag?: string;
};

// Top-level structure: sections with a tiny uppercase heading, plus
// collapsible parent groups for clusters that share an analytical lens.
// Groups self-hide when ALL their children are filtered out by feature/
// access gates — admin never sees an empty disclosure.
type SidebarSection = {
  kind: 'section';
  title: string;
  /** When non-empty, items become children of a single collapsible
   *  parent labeled `groupLabel` instead of being rendered as bare
   *  rows under the section heading. Used for the "Insights" cluster
   *  (Alerts / System Health / Performance / Reports) so we don't drown
   *  the sidebar in 4 sibling rows that semantically belong together. */
  groupLabel?: string;
  groupIcon?: string;
  /** Default expanded state for the group (persisted to localStorage). */
  defaultOpen?: boolean;
  links: SidebarLink[];
};

const sidebarSections: SidebarSection[] = [
  {
    kind: 'section',
    title: 'Overview',
    links: [
      { label: 'Dashboard', href: '/dashboard', icon: 'ri-dashboard-3-line', access: 'dashboard' },
      { label: 'Agents', href: '/agents', icon: 'ri-team-line', requires: ['monitoring_basic'], access: 'agents' },
      { label: 'Live Monitoring', href: '/monitoring', icon: 'ri-computer-line', requires: ['monitoring_basic'], access: 'monitoring' },
    ],
  },
  {
    kind: 'section',
    title: 'Insights',
    groupLabel: 'Insights',
    groupIcon: 'ri-line-chart-line',
    defaultOpen: true,
    links: [
      { label: 'Alerts', href: '/alerts', icon: 'ri-notification-3-line', requires: ['monitoring_basic'], access: 'alerts' },
      { label: 'System Health', href: '/system-health', icon: 'ri-heart-pulse-line', requires: ['monitoring_basic'], access: 'system_health' },
      // Reports now ALSO covers what the old standalone Performance page
      // showed (Top Performer + Departments tab). /performance-reports
      // route still exists but redirects here, so legacy bookmarks work.
      { label: 'Reports', href: '/reports', icon: 'ri-file-chart-line', requires: ['monitoring_basic'], access: 'reports' },
    ],
  },
  {
    kind: 'section',
    title: 'Security',
    links: [
      { label: 'DLP', href: '/dlp', icon: 'ri-shield-keyhole-line', requires: ['dlp'], access: 'dlp' },
    ],
  },
  {
    kind: 'section',
    title: 'Workforce',
    groupLabel: 'People & HR',
    groupIcon: 'ri-team-line',
    defaultOpen: false,
    links: [
      { label: 'Employees', href: '/employees', icon: 'ri-user-add-line', requires: ['employee_management'], access: 'employees' },
      { label: 'Groups & Teams', href: '/employees/groups', icon: 'ri-group-line', requires: ['employee_management'], access: 'groups' },
      { label: 'Managers', href: '/employees/managers', icon: 'ri-user-star-line', requires: ['employee_management'], access: 'managers' },
      { label: 'Credentials Vault', href: '/employees/credentials', icon: 'ri-key-2-line', requires: ['employee_management'], access: 'credentials' },
      // Both gated behind a super-admin global flag (app_features table).
      // Default off — they live on as routes but stay out of the sidebar
      // until the team is ready to ship them. Super admin can flip via
      // Admin Portal → Feature Flags.
      { label: 'Auto-Invoice', href: '/employees/auto-invoice', icon: 'ri-file-list-3-line', requires: ['employee_management'], access: 'credentials', flag: 'auto_invoice' },
      { label: 'OTP Channels', href: '/employees/otp-settings', icon: 'ri-chat-check-line', requires: ['employee_management'], access: 'credentials', flag: 'otp_channels' },
      { label: 'IT Hardware', href: '/employees/hardware', icon: 'ri-computer-line', requires: ['employee_management'], access: 'hardware' },
      { label: 'Offboarding', href: '/employees/offboarding', icon: 'ri-logout-box-line', requires: ['employee_management'], access: 'offboarding' },
      { label: 'Integrations', href: '/employees/integrations', icon: 'ri-plug-line', requires: ['employee_management'], access: 'integrations' },
      { label: 'Email Signatures', href: '/employees/email-signatures', icon: 'ri-mail-settings-line', requires: ['employee_management'], access: 'integrations' },
      { label: 'Governance', href: '/governance', icon: 'ri-organization-chart', requires: ['employee_management'], access: 'governance' },
    ],
  },
  {
    kind: 'section',
    title: 'Setup',
    links: [
      { label: 'Agent Setup', href: '/setup', icon: 'ri-download-cloud-line', requires: ['monitoring_basic'], access: 'setup' },
      // Org Settings moved INTO Admin Portal as the "Branding & Policies"
      // tab so admins have a single home for org-wide config. The
      // /org-settings route still resolves (redirects to /admin-portal)
      // so any existing bookmarks keep working.
      { label: 'Admin Portal', href: '/admin-portal', icon: 'ri-shield-user-line', access: 'admin_portal' },
    ],
  },
];

// Used as a React Router layout route — sidebar + top nav mount once and
// stay mounted across route changes; only the <Outlet /> swaps content.
// Optional `children` prop kept so the few pages still wrapping themselves
// in <DashboardLayout> (legacy / external callers) continue working.
export default function DashboardLayout(props: { children?: React.ReactNode }) {
  // Nested-instance guard. If an ancestor DashboardLayout already mounted
  // (the parent layout-route in router/config.tsx), this instance is a
  // page-level remnant from the pre-layout-route era. Short-circuit:
  // render only the page content, never a second sidebar/header. This
  // makes the 26 pages that still `<DashboardLayout>…</DashboardLayout>`
  // no-ops without touching their files.
  const alreadyMounted = useContext(DashboardLayoutMounted);
  if (alreadyMounted) {
    return <>{props.children ?? <Outlet />}</>;
  }
  return (
    <DashboardLayoutMounted.Provider value={true}>
      <DashboardLayoutChrome>{props.children}</DashboardLayoutChrome>
    </DashboardLayoutMounted.Provider>
  );
}

// The actual sidebar + header + content shell. Split out so the outer
// `DashboardLayout` can short-circuit nested calls without duplicating
// the JSX.
function DashboardLayoutChrome({ children }: { children?: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  // Dev-only mount-lifetime probe. With layout-routes wired correctly,
  // this fires ONCE per session even as the user clicks through Agents
  // → Reports → Settings etc. If you see it fire twice in a single nav,
  // the parent layout-route wrapper is missing / page is not under it.
  // Strip after a release cycle if the noise gets annoying.
  const renders = useRef(0);
  renders.current += 1;
  useEffect(() => {
    if (import.meta.env.DEV) {
      console.info('[DashboardLayout] mounted');
      return () => console.info('[DashboardLayout] unmounted');
    }
  }, []);
  useEffect(() => {
    if (import.meta.env.DEV) {
      console.debug(
        `[DashboardLayout] render #${renders.current} for ${location.pathname}`,
      );
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const { isDark, toggleTheme } = useTheme();
  const { user, organization, signOut } = useAuth();
  const { rows: alertRows } = useAlerts({ sinceHours: 24, limit: 5 });
  const { role: appRole } = useAppRole();
  const features = useFeatures();
  const appAccess = useAppAccess();
  const globalFlags = useGlobalFeatureFlags();
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
    // Global super-admin flag gate. Highest precedence — a feature flipped
    // off here is invisible to every user, regardless of org plan or
    // individual access. Used for half-built features we want to hide
    // everywhere until production-ready.
    if (link.flag) {
      if (globalFlags.loading) return false;
      if (globalFlags.flags[link.flag] === false) return false;
    }
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
  // Filter each section's links through the same gate, then drop sections
  // that end up empty so the user never sees a heading with no rows.
  const visibleSections = sidebarSections
    .map((s) => ({ ...s, links: s.links.filter(linkAllowed) }))
    .filter((s) => s.links.length > 0);
  // Super admins get an extra row tacked onto the very bottom — kept as
  // its own section so it doesn't merge into Setup visually.
  if (appRole === 'super_admin') {
    visibleSections.push({
      kind: 'section',
      title: 'Platform',
      links: [{ label: 'Super Admin', href: '/admin/dashboard', icon: 'ri-shield-keyhole-line' }],
    });
  }

  // Collapsible group state — persist open/closed in localStorage so the
  // admin's expand preferences survive a reload (otherwise the sidebar
  // re-collapses on every page navigation that remounts this component).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem('sidebar.openGroups');
      if (raw) return JSON.parse(raw) as Record<string, boolean>;
    } catch { /* ignore */ }
    return {};
  });
  const currentPath = location.pathname;
  // Whether the group's content is visible right now. If the user has
  // explicitly toggled it (entry exists in openGroups), respect that
  // completely — including a manual collapse while on a child route.
  // Otherwise fall back to defaultOpen, with one auto-open override:
  // when the route is INSIDE the group, the very first render expands
  // it so a fresh visit doesn't hide the user's current location. The
  // moment they tap the chevron, their preference latches forever.
  const isGroupOpen = (section: SidebarSection): boolean => {
    if (!section.groupLabel) return true;
    const explicit = openGroups[section.groupLabel];
    if (typeof explicit === 'boolean') return explicit;
    if (section.links.some((l) => currentPath === l.href)) return true;
    return !!section.defaultOpen;
  };
  // Flip the explicit open/close state. Compute the next value from the
  // CURRENTLY-DISPLAYED state, not from `openGroups[label]` (which is
  // `undefined` on first click — `!undefined === true`, which matches an
  // already-open group, so the first click produced no visible toggle).
  const toggleGroup = (section: SidebarSection) => {
    if (!section.groupLabel) return;
    const label = section.groupLabel;
    const currentlyOpen = isGroupOpen(section);
    setOpenGroups((prev) => {
      const next = { ...prev, [label]: !currentlyOpen };
      try { window.localStorage.setItem('sidebar.openGroups', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const unresolvedAlerts = alertRows.filter((a) => !a.ai_resolved);

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
              src="https://public.readdy.ai/ai/img_res/30434500-ce14-4d0b-944f-490cb4702e27.png"
              alt="Rudrans"
              className="h-8 w-8 object-contain"
            />
            <span className="text-white font-poppins font-bold text-lg tracking-wide">
              Rudrans
            </span>
          </Link>
        </div>

        {/* Nav Links */}
        <nav className="flex-1 py-3 px-3 overflow-y-auto min-h-0 space-y-5">
          {visibleSections.map((section) => (
            <SidebarSectionView
              key={section.title}
              section={section}
              currentPath={currentPath}
              open={isGroupOpen(section)}
              onToggle={() => toggleGroup(section)}
              onLinkClick={undefined}
            />
          ))}
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
              src="https://public.readdy.ai/ai/img_res/30434500-ce14-4d0b-944f-490cb4702e27.png"
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
        <nav className="py-3 px-3 overflow-y-auto h-[calc(100vh-4rem)] space-y-5">
          {visibleSections.map((section) => (
            <SidebarSectionView
              key={section.title}
              section={section}
              currentPath={currentPath}
              open={isGroupOpen(section)}
              onToggle={() => toggleGroup(section)}
              onLinkClick={() => setSidebarOpen(false)}
            />
          ))}
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
            {/* Layout-route render path: the child route's element appears
                here without remounting the surrounding sidebar/header.
                Legacy fallback: if a page still passes `children`, render
                those instead. The two never both exist for the same page. */}
            {children ?? <Outlet />}
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


// Single section block — modern SaaS chrome:
//   • tiny uppercase title outside any pill, sets visual rhythm
//   • flat children for ungrouped sections (1-line rows with icon + label)
//   • disclosure parent + indented children for sections with `groupLabel`
//   • active route: rounded pill with emerald wash + accent dot
//   • inactive: hover lifts to neutral dark with white text
// Both the desktop & mobile sidebars render this; `onLinkClick` is only
// passed by the mobile aside (to close itself on navigation).
function SidebarSectionView({
  section,
  currentPath,
  open,
  onToggle,
  onLinkClick,
}: {
  section: SidebarSection;
  currentPath: string;
  open: boolean;
  onToggle: () => void;
  onLinkClick?: () => void;
}) {
  const hasGroup = !!section.groupLabel;
  const groupActive = hasGroup && section.links.some((l) => currentPath === l.href);

  return (
    <div>
      {/* Section heading. Hidden for the auto-Platform section title we
          tack on for super-admins to keep the bottom of the sidebar quiet. */}
      <div className="px-3 mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.12em] text-gray-500 font-semibold">
          {section.title}
        </span>
      </div>

      {hasGroup ? (
        <>
          {/* Disclosure parent row */}
          <button
            type="button"
            onClick={onToggle}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              groupActive
                ? 'text-white bg-dark-700/40'
                : 'text-gray-300 hover:text-white hover:bg-dark-700/40'
            }`}
            aria-expanded={open}
          >
            <span className="w-5 h-5 flex items-center justify-center text-gray-400">
              <i className={`${section.groupIcon ?? 'ri-folder-line'} text-base`} />
            </span>
            <span className="flex-1 text-left">{section.groupLabel}</span>
            <span className={`w-4 h-4 flex items-center justify-center text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`}>
              <i className="ri-arrow-right-s-line text-sm" />
            </span>
          </button>

          {/* Disclosure children */}
          {open && (
            <div className="mt-0.5 ml-3 pl-3 border-l border-dark-700/60 space-y-0.5">
              {section.links.map((link) => (
                <SidebarRow
                  key={link.href}
                  link={link}
                  active={currentPath === link.href}
                  onClick={onLinkClick}
                  variant="child"
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-0.5">
          {section.links.map((link) => (
            <SidebarRow
              key={link.href}
              link={link}
              active={currentPath === link.href}
              onClick={onLinkClick}
              variant="top"
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One nav row — used both at top-level and as a disclosure child. The
// child variant trades icon prominence for a tighter row so the indent
// reads as obvious hierarchy without crowding the column.
function SidebarRow({
  link,
  active,
  onClick,
  variant,
}: {
  link: SidebarLink;
  active: boolean;
  onClick?: () => void;
  variant: 'top' | 'child';
}) {
  const base = variant === 'top'
    ? 'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors'
    : 'flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] transition-colors';

  const activeCls = variant === 'top'
    ? 'bg-emerald-500/12 text-emerald-300 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.18)]'
    : 'bg-emerald-500/10 text-emerald-300';

  const idleCls = 'text-gray-400 hover:text-white hover:bg-dark-700/50';

  return (
    <Link
      to={link.href}
      onClick={onClick}
      className={`${base} ${active ? activeCls : idleCls}`}
    >
      <span className={`flex items-center justify-center ${variant === 'top' ? 'w-5 h-5' : 'w-4 h-4'}`}>
        <i className={`${link.icon} ${variant === 'top' ? 'text-base' : 'text-sm'}`} />
      </span>
      <span className="flex-1 truncate">{link.label}</span>
      {active && (
        <span className="w-1 h-1 rounded-full bg-emerald-400" aria-hidden="true" />
      )}
    </Link>
  );
}
