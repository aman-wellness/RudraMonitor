import PartnerLayout from '../PartnerLayout';
import InvoicesTable from '@/components/billing/InvoicesTable';
import { useAppRole } from '@/lib/useAppRole';

export default function PartnerInvoices() {
  const { partnerId } = useAppRole();
  return (
    <PartnerLayout title="My Earnings">
      <InvoicesTable scope="partner" partnerId={partnerId} showCommission />
    </PartnerLayout>
  );
}
