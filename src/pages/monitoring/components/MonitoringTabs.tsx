export const tabLabels = [
  { id: 'applications', label: 'Applications', icon: 'ri-apps-line' },
  { id: 'browser', label: 'Browser', icon: 'ri-global-line' },
  { id: 'live', label: 'Live', icon: 'ri-broadcast-line' },
  { id: 'remote', label: 'Remote', icon: 'ri-remote-control-2-line' },
  { id: 'videos', label: 'Videos', icon: 'ri-video-line' },
  { id: 'screenshots', label: 'Screenshots', icon: 'ri-image-line' },
  { id: 'idle', label: 'Idle', icon: 'ri-timer-line' },
] as const;

export type TabId = (typeof tabLabels)[number]['id'];

interface Props {
  active: TabId;
  onChange: (id: TabId) => void;
  // Optional whitelist of tab IDs to render. If omitted, every tab is shown
  // (default behavior, matches pre-gating callers). Used by the monitoring
  // page to hide Live / Remote / Videos / Screenshots when the org's plan
  // doesn't include them.
  visibleIds?: readonly TabId[];
}

export default function MonitoringTabs({ active, onChange, visibleIds }: Props) {
  const tabs: ReadonlyArray<(typeof tabLabels)[number]> = visibleIds
    ? tabLabels.filter((t) => visibleIds.includes(t.id))
    : tabLabels;
  return (
    <div className="flex items-center gap-1 bg-dark-900 rounded-lg p-1 overflow-x-auto">
      {tabs.map((tab) => (
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