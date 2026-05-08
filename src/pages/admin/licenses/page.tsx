import AdminLayout from '../AdminLayout';
import LicensesTable from '@/components/billing/LicensesTable';

export default function AdminLicenses() {
  return (
    <AdminLayout title="Licenses">
      <LicensesTable scope="super_admin" />
    </AdminLayout>
  );
}
