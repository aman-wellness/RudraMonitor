import { ReactNode, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';

const nav = [
  { to: '/partner/dashboard', label: 'Dashboard',  icon: 'ri-dashboard-line' },
  { to: '/partner/customers', label: 'Customers',  icon: 'ri-building-line' },
  { to: '/partner/licenses',  label: 'Licenses',   icon: 'ri-key-2-line' },
  { to: '/partner/invoices',  label: 'My Earnings',icon: 'ri-coin-line' },
  { to: '/partner/profile',   label: 'Profile',    icon: 'ri-user-line' },
];

export default function PartnerLayout({ children, title }: { children: ReactNode; title: string }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const { signOut, user } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleSignOut = async () => {
    try { await signOut(); } finally { navigate('/', { replace: true }); }
  };

  const SidebarBody = (
    <>
      <div className="px-5 py-5 border-b border-dark-800">
        <p className="text-[10px] uppercase tracking-widest text-cyan-400 font-semibold">Wellness Extract</p>
        <p className="text-sm text-white font-semibold mt-0.5">Partner Portal</p>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {nav.map((n) => {
          const active = loc.pathname.startsWith(n.to);
          return (
            <Link
              key={n.to}
              to={n.to}
              onClick={() => setSidebarOpen(false)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                active ? 'bg-dark-800 text-white' : 'text-gray-400 hover:text-white hover:bg-dark-800/50'
              }`}
            >
              <i className={`${n.icon} text-base`} />
              <span>{n.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t border-dark-800">
        <p className="text-[11px] text-gray-600 px-2 mb-2 truncate">{user?.email}</p>
        <button
          onClick={handleSignOut}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-dark-800"
        >
          <i className="ri-logout-box-line" /> Sign out
        </button>
      </div>
    </>
  );

  return (
    <div className="dashboard-shell min-h-screen bg-dark-950 flex overflow-x-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 bg-dark-900 border-r border-dark-800 flex-col fixed left-0 top-0 bottom-0 z-30">
        {SidebarBody}
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={`md:hidden fixed left-0 top-0 bottom-0 w-64 bg-dark-900 border-r border-dark-800 flex flex-col z-50 transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {SidebarBody}
      </aside>

      <main className="flex-1 md:ml-60 min-w-0 min-h-screen flex flex-col overflow-x-hidden">
        <header className="px-4 md:px-6 py-4 border-b border-dark-800 bg-dark-900/80 sticky top-0 backdrop-blur-md z-20 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden w-9 h-9 flex items-center justify-center text-gray-400 hover:text-white"
              aria-label="Open sidebar"
            >
              <i className="ri-menu-line text-lg" />
            </button>
            <h1 className="text-base md:text-lg font-semibold text-white truncate">{title}</h1>
          </div>
          <button
            onClick={toggleTheme}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle theme"
            className="w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-800 transition-colors"
          >
            <i className={isDark ? 'ri-sun-line text-lg' : 'ri-moon-line text-lg'} />
          </button>
        </header>
        <div className="p-4 md:p-6 flex-1 overflow-x-hidden">{children}</div>
      </main>
    </div>
  );
}
