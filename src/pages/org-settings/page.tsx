import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import WallpaperUploadCard from './components/WallpaperUploadCard';
import TrackingScheduleCard from './components/TrackingScheduleCard';

export default function OrgSettingsPage() {
  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-3xl">
        <div>
          <h1 className="text-xl font-semibold text-white">Org Settings</h1>
          <p className="text-xs text-gray-500 mt-1">
            Branding & policies that apply across every agent in your org.
            Per-agent exceptions live on each agent's detail page.
          </p>
        </div>

        <TrackingScheduleCard />
        <WallpaperUploadCard />
      </div>
    </DashboardLayout>
  );
}
