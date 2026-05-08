import PartnerLayout from './PartnerLayout';

export default function PartnerPlaceholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <PartnerLayout title={title}>
      <div className="bg-dark-800 border border-dark-700 rounded-xl p-12 text-center">
        <i className="ri-tools-line text-3xl text-gray-600 mb-3 block" />
        <p className="text-gray-400 text-sm">{title} page coming next.</p>
        {hint && <p className="text-gray-600 text-xs mt-2">{hint}</p>}
      </div>
    </PartnerLayout>
  );
}
