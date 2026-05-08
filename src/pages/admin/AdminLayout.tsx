import { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';

const nav = [
  { to: '/admin/dashboard', label: 'Dashboard',  icon: 'ri-dashboard-line' },
  { to: '/admin/partners',  label: 'Partners',   icon: 'ri-team-line' },
  { to: '/admin/customers', label: 'Customers',  icon: 'ri-building-line' },
  { to: '/admin/licenses',  label: 'Licenses',   icon: 'ri-key-2-line' },
  { to: '/admin/invoices',  label: 'Invoices',   icon: 'ri-bill-line' },
  { to: '/admin/plans',     label: 'Plans',      icon: 'ri-price-tag-3-line' },
  { to: '/admin/audit',     label: 'Audit Log',  icon: 'ri-shield-check-line' },
];

export default function AdminLayout({ children, title }: { children: ReactNode; title: string }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const { signOut, user } = useAuth();

  const handleSignOut = async () => {
    try { await signOut(); } finally { navigate('/', { replace: true }); }
  };

  return (
    <div className="min-h-screen bg-dark-950 flex">
      <aside className="w-60 bg-dark-900 border-r border-dark-800 flex flex-col">
        <div className="px-5 py-5 border-b border-dark-800">
          <p className="text-[10px] uppercase tracking-widest text-purple-400 font-semibold">TrackForce</p>
          <p className="text-sm text-white font-semibold mt-0.5">Super Admin</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map((n) => {
            const active = loc.pathname.startsWith(n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
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
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto">
        <header className="px-6 py-4 border-b border-dark-800 bg-dark-900/40 sticky top-0 backdrop-blur z-10">
          <h1 className="text-lg font-semibold text-white">{title}</h1>
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
