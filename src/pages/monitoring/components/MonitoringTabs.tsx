export const tabLabels = [
  { id: 'applications', label: 'Applications', icon: 'ri-apps-line' },
  { id: 'browser', label: 'Browser', icon: 'ri-global-line' },
  { id: 'videos', label: 'Videos', icon: 'ri-video-line' },
  { id: 'screenshots', label: 'Screenshots', icon: 'ri-image-line' },
  { id: 'idle', label: 'Idle', icon: 'ri-timer-line' },
] as const;

export type TabId = (typeof tabLabels)[number]['id'];

interface Props {
  active: TabId;
  onChange: (id: TabId) => void;
}

export default function MonitoringTabs({ active, onChange }: Props) {
  return (
    <div className="flex items-center gap-1 bg-dark-900 rounded-lg p-1 overflow-x-auto">
      {tabLabels.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-all ${
            active === tab.id
              ? 'bg-dark-700 text-white shadow-sm'
              : 'text-gray-500 hover:text-gray-400'
          }`}
        >
          <span className="w-4 h-4 flex items-center justify-center">
            <i className={`${tab.icon} text-sm`} />
          </span>
          {tab.label}
        </button>
      ))}
    </div>
  );
}