import PartnerLayout from '../PartnerLayout';
import LicensesTable from '@/components/billing/LicensesTable';
import { useAppRole } from '@/lib/useAppRole';

export default function PartnerLicenses() {
  const { partnerId } = useAppRole();
  return (
    <PartnerLayout title="My Licenses">
      <LicensesTable scope="partner" partnerId={partnerId} />
    </PartnerLayout>
  );
}
