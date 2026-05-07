import DashboardLayout from './DashboardLayout';
import StatCards from './components/StatCards';
import AgentTable from './components/AgentTable';
import ProductivityChart from './components/ProductivityChart';
import RecentActivity from './components/RecentActivity';
import AlertsSummary from './components/AlertsSummary';
import { useAuth } from '@/context/AuthContext';
import { useTrialDaysLeft } from '@/lib/dataHooks';

const greet = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
};

export default function Dashboard() {
  const { user, organization } = useAuth();
  const trialDays = useTrialDaysLeft();
  const firstName =
    ((user?.user_metadata?.full_name as string | undefined) || user?.email || 'Admin').split(' ')[0];
  const subStatus = organization?.subscription_status ?? 'trial';
  const trialBadge =
    subStatus === 'trial'
      ? trialDays === null
        ? 'Trial'
        : trialDays > 0
          ? `Trial Active - ${trialDays} day${trialDays === 1 ? '' : 's'} left`
          : 'Trial Expired'
      : subStatus === 'active'
        ? 'Subscription Active'
        : 'Subscription Expired';

  return (
    <DashboardLayout>
      <div className="space-y-5 md:space-y-6">
        {/* Header greeting */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-poppins font-bold text-white">
              {greet()}, {firstName}
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Here&apos;s what&apos;s happening across your organization today
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {trialBadge}
            </span>
            <button className="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-300 text-xs font-medium transition-colors flex items-center gap-1.5">
              <span className="w-4 h-4 flex items-center justify-center">
                <i className="ri-refresh-line text-sm" />
              </span>
              Refresh
            </button>
          </div>
        </div>

        {/* Stat Cards */}
        <StatCards />

        {/* Agent Table */}
        <AgentTable />

        {/* Charts + Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <ProductivityChart />
          <RecentActivity />
        </div>

        {/* Alerts */}
        <AlertsSummary />
      </div>
    </DashboardLayout>
  );
}