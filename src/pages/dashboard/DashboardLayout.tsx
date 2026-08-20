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
import { kindColor, prettyKind } from '@/lib/labels';
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

// Sidebar geometry. Collapsed shows an icon rail; expanded is user-draggable
// between MIN and MAX. Kept here (not in CSS) because the drag handler clamps
// against the same numbers.
const SIDEBAR_DEFAULT_W = 256;
const SIDEBAR_MIN_W = 196;
const SIDEBAR_MAX_W = 380;
const SIDEBAR_RAIL_W = 60;
const SIDEBAR_WIDTH_KEY = 'sidebar.width';
const SIDEBAR_COLLAPSED_KEY = 'sidebar.collapsed';

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

  // ---- Sidebar width: collapsed flag + a user-dragged width ----------------
  // Both persist, and both are expressed through one CSS variable (`--s-w`) so
  // the aside and the content margin can never disagree about the width.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  });
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT_W;
    const raw = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(raw) && raw >= SIDEBAR_MIN_W && raw <= SIDEBAR_MAX_W
      ? raw
      : SIDEBAR_DEFAULT_W;
  });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch { /* private mode */ }
  }, [collapsed]);

  // Pointer-events based so it works with mouse, pen and touch, and so the
  // drag survives the pointer leaving the 6px handle.
  const startResize = (e: React.PointerEvent) => {
    if (collapsed) return;
    e.preventDefault();
    setDragging(true);
    document.body.classList.add('s-resizing');
    const move = (ev: PointerEvent) => {
      const next = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, ev.clientX));
      setWidth(next);
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.classList.remove('s-resizing');
      setDragging(false);
      const final = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, ev.clientX));
      try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(final)); } catch { /* ignore */ }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  const resetWidth = () => {
    setWidth(SIDEBAR_DEFAULT_W);
    try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_DEFAULT_W)); } catch { /* ignore */ }
  };

  // Keyboard resize for anyone not using a pointer.
  const handleKeys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return;
    e.preventDefault();
    if (e.key === 'Home') return resetWidth();
    const step = e.shiftKey ? 32 : 8;
    const next = Math.min(
      SIDEBAR_MAX_W,
      Math.max(SIDEBAR_MIN_W, width + (e.key === 'ArrowRight' ? step : -step)),
    );
    setWidth(next);
    try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next)); } catch { /* ignore */ }
  };

  const railWidth = collapsed ? SIDEBAR_RAIL_W : width;

  // Only the alert nav row carries a count today; keyed by href so adding more
  // later doesn't mean touching the row renderer.
  const badgeFor = (href: string) =>
    href === '/alerts' && unresolvedAlerts.length > 0 ? unresolvedAlerts.length : null;

  // Header title follows the route instead of being hardcoded, so the chrome
  // says "Dashboard" on /dashboard and "Reports" on /reports. Longest-prefix
  // match so detail routes (/agents/:id) inherit their section's title.
  const pageTitle = (() => {
    const all = sidebarSections.flatMap((s) => s.links);
    const exact = all.find((l) => l.href === currentPath);
    if (exact) return exact.label;
    const prefix = all
      .filter((l) => currentPath.startsWith(`${l.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0];
    return prefix?.label ?? 'Dashboard';
  })();


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
    <div
      className="dashboard-shell min-h-screen bg-dark-900 flex overflow-x-hidden"
      style={{ ['--s-w' as string]: `${railWidth}px` }}
    >
      {/* Desktop sidebar */}
      <aside
        className={`s-aside hidden md:flex flex-col fixed left-0 top-0 bottom-0 z-30 ${
          collapsed ? 'is-collapsed' : ''
        } ${dragging ? 'is-dragging' : ''}`}
      >
        <div className="s-brand">
          <Link
            to="/"
            className="flex items-center gap-2.5 min-w-0"
            title={collapsed ? 'Wellness Extract' : undefined}
          >
            <img
              src="https://public.readdy.ai/ai/img_res/30434500-ce14-4d0b-944f-490cb4702e27.png"
              alt="Wellness Extract"
              className="h-7 w-7 object-contain flex-shrink-0"
            />
            <span className="s-brand-name truncate">Wellness Extract</span>
          </Link>
          {!collapsed && (
            <button
              onClick={() => setCollapsed(true)}
              className="s-hbtn ml-auto"
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <i className="ri-contract-left-line text-[15px]" />
            </button>
          )}
        </div>

        {collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            className="s-hbtn mx-auto mt-2"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <i className="ri-contract-right-line text-[15px]" />
          </button>
        )}

        <nav className="s-nav">
          {visibleSections.map((section) => (
            <SidebarSectionView
              key={section.title}
              section={section}
              currentPath={currentPath}
              open={isGroupOpen(section)}
              collapsed={collapsed}
              badgeFor={badgeFor}
              onToggle={() => {
                // In the rail the children aren't rendered, so a "toggle" would
                // silently close an already-open group. Clicking a group icon
                // there means "take me in": expand the rail, then make sure the
                // group is open.
                if (collapsed) {
                  setCollapsed(false);
                  if (!isGroupOpen(section)) toggleGroup(section);
                  return;
                }
                toggleGroup(section);
              }}
              onLinkClick={undefined}
            />
          ))}
        </nav>

        <div className="s-foot">
          <button
            onClick={handleSignOut}
            className="s-user"
            title={collapsed ? `${fullName} — sign out` : 'Sign out'}
          >
            <span className="s-user-av">{initials}</span>
            <span className="s-user-meta flex-1 min-w-0">
              <span className="block text-[11.5px] font-medium truncate" style={{ color: 'var(--d-t1)' }}>
                {fullName}
              </span>
              <span className="block text-[10px] truncate" style={{ color: 'var(--d-t3)' }}>
                {orgName}
              </span>
            </span>
            <i
              className="s-user-meta ri-logout-box-r-line text-[14px] flex-shrink-0"
              style={{ color: 'var(--d-t3)' }}
            />
          </button>
        </div>

        {/* Drag to resize. Double-click or Home resets to the default width. */}
        {!collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuenow={width}
            aria-valuemin={SIDEBAR_MIN_W}
            aria-valuemax={SIDEBAR_MAX_W}
            tabIndex={0}
            className={`s-handle ${dragging ? 'is-active' : ''}`}
            onPointerDown={startResize}
            onDoubleClick={resetWidth}
            onKeyDown={handleKeys}
            title="Drag to resize · double-click to reset"
          />
        )}
      </aside>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile drawer — always full width, never collapsed or resizable. */}
      <aside
        className={`s-aside md:hidden fixed left-0 top-0 bottom-0 z-50 transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ ['--s-w' as string]: `${SIDEBAR_DEFAULT_W}px` }}
      >
        <div className="s-brand">
          <Link to="/" className="flex items-center gap-2.5" onClick={() => setSidebarOpen(false)}>
            <img
              src="https://public.readdy.ai/ai/img_res/30434500-ce14-4d0b-944f-490cb4702e27.png"
              alt="Wellness Extract"
              className="h-7 w-7 object-contain"
            />
            <span className="s-brand-name">Wellness Extract</span>
          </Link>
          <button
            onClick={() => setSidebarOpen(false)}
            className="s-hbtn ml-auto"
            aria-label="Close sidebar"
          >
            <i className="ri-close-line text-[17px]" />
          </button>
        </div>
        <nav className="s-nav">
          {visibleSections.map((section) => (
            <SidebarSectionView
              key={section.title}
              section={section}
              currentPath={currentPath}
              open={isGroupOpen(section)}
              collapsed={false}
              badgeFor={badgeFor}
              onToggle={() => toggleGroup(section)}
              onLinkClick={() => setSidebarOpen(false)}
            />
          ))}
        </nav>
      </aside>

      {/* Main Content */}
      <div
        className={`s-main flex-1 min-h-screen flex flex-col min-w-0 ${dragging ? 'is-dragging' : ''}`}
      >
        {/* Top Header */}
        <header className="s-header sticky top-0 z-20">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="s-hbtn md:hidden"
              aria-label="Open sidebar"
            >
              <i className="ri-menu-line text-[18px]" />
            </button>
            <h2 className="s-title truncate">{pageTitle}</h2>
          </div>

          <div className="flex items-center gap-1.5">

            {/* Notifications */}
            <div className="relative">
              <button
                onClick={() => setNotifOpen(!notifOpen)}
                className="s-hbtn"
                aria-label="Notifications"
              >
                <i className="ri-notification-3-line text-[17px]" />
                {unresolvedAlerts.length > 0 && (
                  <span className="s-badge absolute top-0.5 right-0.5">
                    {unresolvedAlerts.length > 9 ? '9+' : unresolvedAlerts.length}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="s-pop w-72">
                  <div className="px-3.5 py-2.5 s-pop-head">
                    <span className="text-[11.5px] font-medium t1">Notifications</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {alertRows.length === 0 ? (
                      <div className="px-4 py-6 text-center text-[11px] t3">
                        No recent alerts.
                      </div>
                    ) : (
                      alertRows.map((a) => (
                        <div key={a.id} className="px-3.5 py-2.5 cell cursor-pointer">
                          <div className="flex items-start gap-2.5">
                            <span
                              className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                              style={{ background: kindColor(a.alert_type) }}
                              title={prettyKind(a.alert_type)}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-[11px] leading-snug truncate t2">{a.message}</p>
                              <p className="text-[9.5px] mt-0.5 t3">
                                {a.agent_name ?? 'Agent'} · {formatRelative(a.created_at)}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="px-3.5 py-2 text-center s-pop-foot">
                    <Link to="/alerts" className="text-[10.5px] font-medium t-accent hover:underline">
                      View all alerts
                    </Link>
                  </div>
                </div>
              )}
            </div>

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="s-hbtn"
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label="Toggle theme"
            >
              <i className={isDark ? 'ri-sun-line text-[17px]' : 'ri-moon-line text-[17px]'} />
            </button>

          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 min-w-0 w-full p-2.5 md:p-3.5 lg:p-4 overflow-y-auto overflow-x-hidden">
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


// One section block: a tiny uppercase heading, then either flat rows or a
// disclosure parent with indented children. In the collapsed rail the heading
// becomes a hairline divider and labels/chevrons are hidden by CSS — the markup
// stays identical so nothing has to re-mount when the rail toggles.
// Both the desktop aside and the mobile drawer render this; `onLinkClick` is
// only passed by the drawer (to close itself on navigation).
function SidebarSectionView({
  section,
  currentPath,
  open,
  collapsed,
  badgeFor,
  onToggle,
  onLinkClick,
}: {
  section: SidebarSection;
  currentPath: string;
  open: boolean;
  collapsed: boolean;
  badgeFor: (href: string) => number | null;
  onToggle: () => void;
  onLinkClick?: () => void;
}) {
  const hasGroup = !!section.groupLabel;
  const groupActive = hasGroup && section.links.some((l) => currentPath === l.href);
  // Count badges from collapsed children surface on the group row, so a rail
  // user still sees that something inside needs attention.
  const groupBadge = hasGroup
    ? section.links.reduce((sum, l) => sum + (badgeFor(l.href) ?? 0), 0)
    : 0;

  return (
    <div>
      <div className="s-sec" aria-hidden={collapsed ? 'true' : undefined}>
        {section.title}
      </div>

      {hasGroup ? (
        <>
          <button
            type="button"
            onClick={onToggle}
            className={`s-row ${groupActive ? 'is-within' : ''}`}
            aria-expanded={open}
            title={collapsed ? section.groupLabel : undefined}
          >
            <i className={`s-ico ${section.groupIcon ?? 'ri-folder-line'}`} />
            <span className="s-label text-left">{section.groupLabel}</span>
            {/* Surface the children's count on the parent whenever those
                children aren't visible — closed, or hidden by the rail. */}
            {groupBadge > 0 && (!open || collapsed) && (
              <span className="s-badge">{groupBadge > 9 ? '9+' : groupBadge}</span>
            )}
            <i className={`s-chev ri-arrow-right-s-line ${open ? 'is-open' : ''}`} />
          </button>

          {/* Height-animated so expanding doesn't snap the column. */}
          <div className={`s-kids-wrap ${open && !collapsed ? 'is-open' : ''}`}>
            <div className="s-kids">
              {section.links.map((link) => (
                <SidebarRow
                  key={link.href}
                  link={link}
                  active={currentPath === link.href}
                  badge={badgeFor(link.href)}
                  collapsed={collapsed}
                  onClick={onLinkClick}
                  variant="child"
                />
              ))}
            </div>
          </div>
        </>
      ) : (
        section.links.map((link) => (
          <SidebarRow
            key={link.href}
            link={link}
            active={currentPath === link.href}
            badge={badgeFor(link.href)}
            collapsed={collapsed}
            onClick={onLinkClick}
            variant="top"
          />
        ))
      )}
    </div>
  );
}

// One nav row, top-level or disclosure child. The child variant is shorter and
// a step smaller so the indent reads as hierarchy without a second colour.
function SidebarRow({
  link,
  active,
  badge,
  collapsed,
  onClick,
  variant,
}: {
  link: SidebarLink;
  active: boolean;
  badge: number | null;
  collapsed: boolean;
  onClick?: () => void;
  variant: 'top' | 'child';
}) {
  return (
    <Link
      to={link.href}
      onClick={onClick}
      title={collapsed ? link.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={`s-row ${variant === 'child' ? 'is-child' : ''} ${active ? 'is-active' : ''}`}
    >
      <i className={`s-ico ${link.icon}`} />
      <span className="s-label">{link.label}</span>
      {badge !== null && <span className="s-badge">{badge > 9 ? '9+' : badge}</span>}
    </Link>
  );
}
