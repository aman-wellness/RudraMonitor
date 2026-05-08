import AdminLayout from '../AdminLayout';
import InvoicesTable from '@/components/billing/InvoicesTable';

export default function AdminInvoices() {
  return (
    <AdminLayout title="Invoices">
      <InvoicesTable scope="super_admin" />
    </AdminLayout>
  );
}
