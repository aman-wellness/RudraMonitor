import { detailBottomTabs, type DetailTabId } from '@/mocks/agentDetail';

interface Props {
  active: DetailTabId;
  onChange: (id: DetailTabId) => void;
  counts: Record<string, number | null>;
}

export default function BottomTabs({ active, onChange, counts }: Props) {
  return (
    <div className="flex items-center gap-1 bg-dark-900 rounded-lg p-1 overflow-x-auto">
      {detailBottomTabs.map((tab) => {
        // Badge shows the REAL count from props only. Never fall back to
        // the mock `tab.count` literals (33/97/…) — those are placeholders
        // in the tab definition, not data.
        const count = counts[tab.id] ?? null;
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
              isActive ? 'bg-dark-700 text-white shadow-sm' : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            <span className="w-3.5 h-3.5 flex items-center justify-center">
              <i className={`${tab.icon} text-xs`} />
            </span>
            {tab.label}
            {count !== null && (
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${isActive ? 'bg-dark-600 text-gray-300' : 'bg-dark-800 text-gray-500'}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}