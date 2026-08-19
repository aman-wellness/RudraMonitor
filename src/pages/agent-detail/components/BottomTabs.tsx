import { detailBottomTabs, type DetailTabId } from '@/mocks/agentDetail';

interface Props {
  active: DetailTabId;
  onChange: (id: DetailTabId) => void;
  counts: Record<string, number | null>;
}

/* Section switcher, in the same segmented shape used across the app.
   Scrolls horizontally on narrow screens rather than wrapping to two rows. */
export default function BottomTabs({ active, onChange, counts }: Props) {
  return (
    <div className="seg overflow-x-auto max-w-full">
      {detailBottomTabs.map((tab) => {
        // Real count from props only. The mock tab definitions carry literals
        // (33/97/…) that are placeholders, never data.
        const count = counts[tab.id] ?? null;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`seg-btn ${active === tab.id ? 'is-on' : ''}`}
          >
            <span className="inline-flex items-center gap-1.5">
              <i className={`${tab.icon} text-[12px]`} />
              {tab.label}
              {count !== null && <span className="t3">{count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
