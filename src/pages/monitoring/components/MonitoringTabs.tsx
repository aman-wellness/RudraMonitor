import { tabLabels, type TabId } from './tabs';

interface Props {
  active: TabId;
  onChange: (id: TabId) => void;
  // Optional whitelist of tab IDs to render. If omitted, every tab is shown
  // (default behavior, matches pre-gating callers). Used by the monitoring
  // page to hide Live / Remote / Videos / Screenshots when the org's plan
  // doesn't include them.
  visibleIds?: readonly TabId[];
}

/* The app's one segmented-control shape, same as the agent-detail tabs. */
export default function MonitoringTabs({ active, onChange, visibleIds }: Props) {
  const tabs: ReadonlyArray<(typeof tabLabels)[number]> = visibleIds
    ? tabLabels.filter((t) => visibleIds.includes(t.id))
    : tabLabels;
  return (
    <div className="seg overflow-x-auto max-w-full">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`seg-btn ${active === tab.id ? 'is-on' : ''}`}
        >
          <span className="inline-flex items-center gap-1.5">
            <i className={`${tab.icon} text-[12px]`} />
            {tab.label}
          </span>
        </button>
      ))}
    </div>
  );
}
